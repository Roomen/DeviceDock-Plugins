import core from './core.js'
import { createFirmwareLibrary } from './library.js'
export function verifyPackage(input) {
 const data = input.slice(), view = new DataView(data.buffer, data.byteOffset, data.byteLength)
 if (data.length < 128 || view.getUint32(0, true) !== core.MAGIC_NUM) throw Error('Invalid package magic/size')
 const type = view.getUint32(8, true), size = view.getUint32(16, true)
 if (![1, 2, 3].includes(type) || view.getUint32(12, true) !== 0) throw Error('Unsupported package type/encryption')
 if (data.length !== 128 + size) throw Error('Package length mismatch')
 if (core.crc32(data.subarray(0, 124)) !== view.getUint32(124, true)) throw Error('Header CRC mismatch')
 if (core.crc32(data.subarray(128)) !== view.getUint32(20, true)) throw Error('Data CRC mismatch')
 let end = 48; while (end < 64 && data[end]) end++
 const version = new TextDecoder().decode(data.subarray(48, end))
 if (!version || !/^[\x20-\x7e]+$/.test(version)) throw Error('Missing/invalid embedded version')
 return { data, version, type, oldCRC: view.getUint32(32, true), newCRC: view.getUint32(40, true) }
}
const aborted = signal => { if (signal.aborted) throw Error('Firmware task cancelled') }
export function createInbox(scope, codec, generation) {
 const frames = [], waiters = new Set(); let fault = null, awaitingNotify = null, transferCodes = []
 const off = scope.subscribe(row => {
  if (row.direction !== 'rx' || row.generation !== generation) return
  try { for (const frame of codec.feed(row.bytes)) { if (awaitingNotify != null) { if (frame.code === awaitingNotify) awaitingNotify = null; else if (transferCodes.includes(frame.code)) continue }; if (frames.length >= 512) throw Error('Firmware receive queue overflow'); frames.push(frame) }; for (const fn of [...waiters]) fn() }
  catch (e) { fault = e; for (const fn of [...waiters]) fn() }
 })
 function next(codes, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
   let timer
   const finish = (e, value) => { clearTimeout(timer); waiters.delete(check); scope.signal.removeEventListener('abort', cancel); e ? reject(e) : resolve(value) }
   const cancel = () => finish(Error('Firmware task cancelled'))
   const check = () => { if (fault) return finish(fault); const i = frames.findIndex(f => codes.includes(f.code)); if (i !== -1) finish(null, frames.splice(i, 1)[0].bytes) }
   timer = setTimeout(() => finish(Error('Firmware response timeout')), timeoutMs)
   waiters.add(check); scope.signal.addEventListener('abort', cancel, { once: true }); if (scope.signal.aborted) cancel(); else check()
  })
 }
 return { next, beginAttempt(notifyCode, codes) { frames.length = 0; codec.reset(); awaitingNotify = notifyCode; transferCodes = codes }, reset() { frames.length = 0; codec.reset() }, dispose() { off(); codec.reset(); fault = Error('Firmware inbox closed'); for (const fn of [...waiters]) fn(); frames.length = 0 } }
}
export function delay(ms, signal) {
 return new Promise((resolve, reject) => { const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(Error('Firmware task cancelled')) }; const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, ms); signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel() })
}
export function createFirmwareService(host) {
 let active = null, disposed = false
 const library = createFirmwareLibrary(host.storage)
 const listeners = new Set()
 const emit = state => { for (const fn of listeners) { try { fn(state) } catch {} } }
 async function task(fn, context) {
  if (active || disposed || host.signal.aborted) throw Error('Firmware service busy or inactive')
  const controller = new AbortController(), relay = () => controller.abort()
  host.signal.addEventListener('abort', relay, { once: true }); context?.signal.addEventListener('abort', relay, { once: true }); if (context?.signal.aborted) controller.abort(); active = controller
  try { return await fn(controller.signal) }
  catch (e) { emit({ phase: 'error', error: e.message }); throw e }
  finally { host.signal.removeEventListener('abort', relay); context?.signal.removeEventListener('abort', relay); active = null }
 }
 async function transfer(lane, packageData, signal, options) {
  let target = packageData && verifyPackage(packageData)
  const codecAPI = host.getService('org.devicedock.sek.firmware.v1')
  if (codecAPI?.apiVersion !== 1) throw Error('Enable the SEK firmware codec package first')
  const session = host.session(lane), generation = session.generation, chunkSize = options.chunkSize ?? 128
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 512) throw Error('Chunk size must be 1–512')

  return session.transaction('org.devicedock.firmware.v1', async scope => {
   const inbox = createInbox(scope, codecAPI.create(), generation), codes = codecAPI.codes
   let committed = false
   const fence = async () => {
    aborted(scope.signal)
    const expected = options.context?.snapshot?.lanes?.[lane]?.generation
    if (session.generation !== generation || expected != null && expected !== generation) throw Error('Firmware request connection changed')
    if (options.context && !committed) { await options.context.commit(); committed = true }
    aborted(scope.signal)
    if (session.generation !== generation) throw Error('Firmware connection changed')
   }
   const send = async (bytes, prepare) => { aborted(scope.signal); await scope.send(bytes, { beforeWrite: async () => { await fence(); prepare?.() } }); aborted(scope.signal) }
   try {
    emit({ phase: 'query', progress: 0 }); await send(codecAPI.queryVersion())
    const version = codecAPI.parseVersion(await inbox.next([codes.queryVersion], 5000))
    if (version.resultCode) throw Error('Version query rejected: ' + version.resultCode)
    if (options.prepare) target = verifyPackage(await options.prepare(version.version, scope.signal))
    while (true) {
     const total = Math.ceil(target.data.length / chunkSize), sent = new Set()
     emit({ phase: 'notify', deviceVersion: version.version, progress: 0 }); await send(codecAPI.notify(target.version, chunkSize, total), () => inbox.beginAttempt(codes.newVersion, [codes.downloadRequest, codes.downloadResult]))
     const notify = codecAPI.parseNotify(await inbox.next([codes.newVersion], 5000))
     if (notify.resultCode) throw Error('Upgrade rejected: ' + notify.resultCode)
     while (true) {
      const bytes = await inbox.next([codes.downloadRequest, codes.downloadResult], 30000)
      // One complete frame can be classified without mutating the streaming parser.
      const probe = codecAPI.create(); let code
      try { code = probe.feed(bytes)[0]?.code } finally { probe.reset() }
      if (code === codes.downloadResult) {
       const result = codecAPI.parseResult(bytes)
       if (result.downloadStatus) {
        // Confirm receipt of a rejected diff before starting a fresh compressed download.
        await send(codecAPI.acknowledge(0))
        if (options.fallback && target.type === core.PKG_DIFF && core.shouldFallbackToCompress('diff', result.downloadStatus)) {
         emit({ phase: 'fallback', downloadStatus: result.downloadStatus })
         target = verifyPackage(await options.fallback(scope.signal)); inbox.reset(); break
        }
        throw Object.assign(Error('Download failed: ' + result.downloadStatus), { downloadStatus: result.downloadStatus })
       }
       await send(codecAPI.acknowledge(0)); await delay(500, scope.signal); await send(codecAPI.execute())
       emit({ phase: 'execute-sent', progress: 1, message: 'Execute command sent; verify device firmware after reconnect' }); return { executed: true, verified: false }
      }
      const { chunkIndex } = codecAPI.parseRequest(bytes)
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= total) throw Error('Invalid requested chunk index')
      const chunk = new Uint8Array(chunkSize).fill(0xff); chunk.set(target.data.subarray(chunkIndex * chunkSize, (chunkIndex + 1) * chunkSize))
      await delay(options.replyDelayMs ?? 200, scope.signal); await send(codecAPI.chunk(chunkIndex, chunk, target.version))
      const resend = sent.has(chunkIndex); sent.add(chunkIndex); emit({ phase: 'transfer', sent: sent.size, total, resend, chunkIndex, bytesSent: sent.size * chunkSize, progress: sent.size / total })
     }
    }
   } catch (cause) { if (committed) throw Object.assign(Error('Firmware operation partial/unknown; inspect device before retry: ' + cause.message, { cause }), { outcome: 'partial-or-unknown', downloadStatus: cause.downloadStatus }); throw cause } finally { inbox.dispose() }
  }, { signal, timeoutMs: options.timeoutMs ?? 20 * 60 * 1000 })
 }
 const api = {
  core, verifyPackage,
  status: () => ({ busy: !!active }),
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
  cancel() { active?.abort() },
  package(type, newData, baseData, userDefine = '') {
   const fresh = newData.slice(), base = baseData?.slice()
   return task(async signal => {
    aborted(signal)
    if (type === 'origin') { if (!core.embeddedVersion(fresh)) throw Error('Raw firmware lacks embedded version'); return core.joinPackage(core.packFirmware({ firmwareData: fresh, pkgType: core.PKG_ORIGIN, userDefine }), fresh) }
    const runner = host.getService('org.devicedock.firmware.patch.v1')
    if (!runner?.createPatch) throw Error('Compression/diff requires an explicitly installed licensed HDiff patch provider; enable the HPatchLite patch provider')
    const result = await core.buildPackage(type, fresh, type === 'compress' ? core.BLANK_BUILTIN : base, (oldBytes, newBytes) => runner.createPatch(oldBytes, newBytes, { signal }), userDefine)
    aborted(signal); return result
   })
  },
  upgrade(lane, data, options = {}) { const bytes = data.slice(); return task(signal => transfer(lane, bytes, signal, options), options.context) },
  upgradeAutomatic(lane, data, options = {}) {
   const fresh = data.slice()
   return task(async signal => {
    if (!core.embeddedVersion(fresh) || fresh.length > 4_000_000) throw Error('Automatic upgrade requires raw firmware under 4 MB with embedded version')
    const provider = host.getService('org.devicedock.firmware.patch.v1')
    if (!provider?.createPatch) throw Error('Enable the licensed HPatchLite patch provider first')
    const build = async (type, base, taskSignal) => {
     aborted(taskSignal); emit({ phase: 'packaging', mode: type })
     const pkg = await core.buildPackage(type, fresh, base, (a, b) => provider.createPatch(a, b, { signal: taskSignal }), options.userDefine || '')
     aborted(taskSignal); return pkg
    }
    const compress = taskSignal => build('compress', core.BLANK_BUILTIN, taskSignal)
    return transfer(lane, null, signal, { ...options,
     prepare: async (version, taskSignal) => {
      const candidates = (await library.list({ signal: taskSignal })).filter(row => core.sameVersion(row.version, version))
      // Distinct SHA-256 records count as distinct builds, even if CRC32 collides.
      if (candidates.length !== 1) { emit({ phase: 'baseline', reason: candidates.length ? 'ambiguous' : 'not-found' }); return compress(taskSignal) }
      const base = await library.read(candidates[0].id, { signal: taskSignal })
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', base.data)), b => b.toString(16).padStart(2, '0')).join('')
      if (digest !== base.id || core.crc32(base.data) !== base.crc || !core.sameVersion(core.embeddedVersion(base.data), version)) throw Error('Firmware library baseline integrity failed')
      emit({ phase: 'baseline', reason: 'unique-exact-library-image', name: base.name })
      return build('diff', base.data, taskSignal)
     }, fallback: compress,
    })
   })
  },
  upgradeLibrary(lane, id, options = {}) {
   return task(async signal => { const row = await library.read(id, { signal }); const pkg = core.joinPackage(core.packFirmware({ firmwareData: row.data, pkgType: core.PKG_ORIGIN }), row.data); return transfer(lane, pkg, signal, options) }, options.context)
  },
  queryVersion(lane, context) {
   return task(signal => {
    const codecAPI = host.getService('org.devicedock.sek.firmware.v1')
    if (codecAPI?.apiVersion !== 1) throw Error('Enable the SEK firmware codec package first')
    const session = host.session(lane), generation = session.generation
    return session.transaction('org.devicedock.firmware.v1', async scope => {
     const inbox = createInbox(scope, codecAPI.create(), generation)
     try { await scope.send(codecAPI.queryVersion(), { beforeWrite: async () => { aborted(scope.signal); if (context?.snapshot?.lanes?.[lane]?.generation != null && context.snapshot.lanes[lane].generation !== session.generation) throw Error('Firmware request connection changed'); await context?.commit(); aborted(scope.signal); if (session.generation !== generation) throw Error('Firmware connection changed') } }); const result = codecAPI.parseVersion(await inbox.next([codecAPI.codes.queryVersion], 5000)); if (result.resultCode) throw Error('Version query rejected: ' + result.resultCode); return result.version } finally { inbox.dispose() }
    }, { signal, timeoutMs: 6000 })
   }, context)
  },
  importLibraryJSON(input) {
   return task(async signal => {
    const rows = Array.isArray(input) ? input : input?.entries
    if (!Array.isArray(rows) || rows.length > 20) throw Error('Expected at most 20 firmware records')
    // Validate all source bytes before changing the destination; never trust old CRC/version metadata.
    const prepared = rows.map(row => {
     const values = row.data || row.bytes
     if (!Array.isArray(values) || values.length > 32 * 1024 * 1024 || values.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw Error('Invalid firmware byte array')
     const data = Uint8Array.from(values), version = core.embeddedVersion(data)
     if (!version) throw Error('Library requires embedded raw firmware version')
     return { data, meta: { name: String(row.name || 'Imported firmware').slice(0, 160), version, crc: core.crc32(data) } }
    })
    if (prepared.reduce((n, row) => n + row.data.length, 0) > 32 * 1024 * 1024) throw Error('Import exceeds library budget')
    return library.addMany(prepared, { signal })
   })
  },
  library: options => library.list(options),
  readLibrary: (id, options) => library.read(id, options),
  removeFromLibrary: (id, options) => task(signal => library.remove(id, { ...options, signal })),
  addToLibrary(name, bytes) {
   const copy = bytes.slice(), version = core.embeddedVersion(copy)
   if (!version) return Promise.reject(Error('Library requires embedded raw firmware version'))
   return task(signal => library.add({ name, version, crc: core.crc32(copy) }, copy, { signal, report: true }))
  },
  async dispose() { if (active) throw Error('Cancel firmware task and await completion before disabling'); await library.close(); disposed = true; listeners.clear() },
 }
 return api
}
