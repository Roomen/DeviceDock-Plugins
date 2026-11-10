import { createAnchorTrack } from './serial-events.js'
import { CaptureStatistics } from './statistics.js'
import { parseCaptureCSV } from './csv.js'
import BLU from './codec.js'
import analysis from './analysis.js'
import { analyzeCapture } from './capture-analysis.js'
import { BlockStore } from './stream.js'
import { CaptureArchive } from './archive.js'
import { CaptureGate } from './trigger.js'
export function createPowerService(host) {
 const dedicated = host.resources.createSession('instrument')
 const sessionFor = lane => lane === 'instrument' ? dedicated : host.session(lane)
 const owner = 'org.devicedock.power.v1'
 let identity = host.storage.get('captureDatabase')
 if (!identity) { identity = crypto.randomUUID(); host.storage.set('captureDatabase', identity) }
 const archive = new CaptureArchive('devicedock.power.' + identity)
 let archiveQueue = Promise.resolve(), archivePending = 0, archiveError = null, archivedId = null, gate = null
 let anchors = createAnchorTrack(), eventRows = [], eventsDropped = 0
 let offEvents = []
 const stopEvents = () => { for (const off of offEvents) off(); offEvents = [] }
 let rawBuffer = null, rawLength = 0, parserStats = {}
 let storageBusy = false, recordMode = 'wave', totals = new CaptureStatistics()
 let queue = Promise.resolve(), disposed = false, pending = 0, capture = null, power = null, voltage = null
 const store = new BlockStore(), listeners = new Set()
 const emit = () => { for (const fn of listeners) { try { fn(status()) } catch {} } }
 function reconcileCapture() {
  if (capture && capture.session.generation !== capture.generation && !['closing', 'cleanup-needed', 'opening'].includes(capture.session.state)) {
   const previous = capture, id = archivedId; capture = null; stopEvents(); previous.off(); previous.release(); power = null; voltage = null
   if (id) {
    archivePending++
    archiveQueue = archiveQueue.then(() => archive.finish(id, 'disconnected')).catch(e => { archiveError = e.message }).finally(() => { archivePending--; emit() })
   }
  }
 }
 const status = () => { reconcileCapture(); return ({ busy: pending > 0 || !!capture || archivePending > 0, sampling: !!capture, captureLane: capture?.lane, recordMode, totalSamples: totals.n, power, voltage, samples: store.samples, evicted: store.evicted, trigger: gate?.phase, triggerTime: gate?.triggerTime, archivePending, archiveError, archivedId }) }
 const check = (session, generation) => { if (disposed || host.signal.aborted) throw Error('Power service inactive'); if (session.generation !== generation) throw Error('Connection changed') }
 function operation(lane, fn, context) {
  const session = sessionFor(lane), generation = session.generation
  const requestedGeneration = context?.snapshot?.lanes?.[lane]?.generation
  const guard = () => { context?.signal?.throwIfAborted(); check(session, generation); if (requestedGeneration != null && requestedGeneration !== session.generation) throw Error('Request connection changed') }
  let committed = false
  const fence = async () => { guard(); if (context && !committed) { await context.commit(); committed = true }; guard() }
  if (storageBusy) return Promise.reject(Error('Capture storage operation in progress'))
  if (disposed || host.signal.aborted) return Promise.reject(Error('Power service inactive'))
  pending++; emit()
  const work = queue.then(async () => {
   guard()
   const release = session.claim(owner)
   try { return await fn({ session, generation, send: async (bytes, prepare) => { guard(); await session.send(bytes, { owner, generation, beforeWrite: async () => { await fence(); prepare?.() } }); guard() } }) }
   catch (e) { power = null; throw e }
   finally { release() }
  }).finally(() => { pending--; emit() })
  queue = work.catch(() => {}); return work
 }
 async function stopCapture(send) {
  const active = capture
  if (!active) return
  // Retain exclusive ownership until stop write has completed.
  await send(BLU.cmdAverageStop())
  active.off(); stopEvents(); await archiveQueue; if (archivedId) await archive.finish(archivedId, archiveError ? 'error' : 'saved'); active.release(); capture = null; emit()
 }
 const api = {
  status, store, analysis,
  serialEvents: () => ({ dropped: eventsDropped, rows: eventRows.map(row => ({ ...row, seconds: anchors.perfToLi(row.perf) })) }),
  captureRaw(bytes = 4 * 1024 * 1024) { if (status().sampling) throw Error('Arm raw capture before sampling'); if (!Number.isInteger(bytes) || bytes < 4096 || bytes > 16 * 1024 * 1024) throw Error('Raw capture limit must be 4 KB–16 MiB'); rawBuffer = new Uint8Array(bytes); rawLength = 0; return bytes },
  dumpRaw: () => rawBuffer?.slice(0, rawLength) || new Uint8Array(),
  streamStats: () => ({ ...parserStats, capturedBytes: rawLength }),
  importCapture(data) { if (status().busy || disposed) throw Error('Stop acquisition first'); store.import(data); recordMode = 'wave'; emit() },
  importCSV(text) { if (status().busy || disposed) throw Error('Stop acquisition first'); const next = parseCaptureCSV(text); store.import(next.export()); recordMode = 'wave'; emit(); return { samples: store.samples } },
  summary() {
   if (recordMode === 'long') return totals.summary()
   const result = analyzeCapture(store)
   let energyUWh = 0, known = true
   for (const block of store.blocks) {
    if (!Number.isFinite(block.voltageMv)) { known = false; continue }
    for (const value of block.values) energyUWh += value * ({ A: 1e6, mA: 1e3, 'µA': 1, uA: 1, nA: 1e-3 }[block.unit] ?? NaN) * block.voltageMv / 1000 / block.rateHz / 3600
   }
   return { ready: store.samples > 0, retainedSamples: store.samples, totalSamples: store.samples + store.evicted, span: store.evicted ? 'retained' : 'all', unit: result.unit, current: result.stats, chargeUC: result.integral.value * ({ A: 1e6, mA: 1e3, 'µA': 1, uA: 1, nA: 1e-3 }[result.unit] ?? NaN), energyUWh: known && store.samples ? energyUWh : null, energySource: known ? 'stored_block_voltages' : 'unknown_voltage', voltageChangedDuringCapture: new Set(store.blocks.map(b => b.voltageMv)).size > 1 }
  },
  analyze: options => analyzeCapture(store, options),
  captures: async () => (await archive.list()).map(row => row.state === 'recording' && (!capture || row.id !== archivedId) && !archivePending ? { ...row, state: 'interrupted' } : row),
  async removeCapture(id) { if (status().busy) throw Error('Stop acquisition first'); storageBusy = true; pending++; try { await archive.remove(id) } finally { storageBusy = false; pending--; emit() } },
  async exportCaptureCSV(id, { offset = 0, limit = 200000 } = {}) {
   if (status().busy) throw Error('Stop acquisition first')
   if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200000) throw Error('CSV segment must contain 1–200000 samples')
   storageBusy = true; pending++
   try {
    let seen = 0, exported = 0
    const parts = ['seconds,current,unit,rateHz,gapsBeforeBlock,voltage_mV\n']
    const blocks = id ? archive.blocks(id) : store.blocks
    for await (const block of blocks) {
     const lines = []
     for (let i = 0; i < block.values.length; i++) { if (seen++ < offset) continue; if (exported >= limit) break; exported++; lines.push(`${block.times[i]},${block.values[i]},${block.unit},${block.rateHz},${lines.length === 0 ? (block.gaps?.length || 0) : 0},${block.voltageMv ?? ''}\n`) }
     parts.push(lines.join(''))
     if (exported >= limit) break
    }
    return new Blob(parts, { type: 'text/csv' })
   } finally { storageBusy = false; pending--; emit() }
  },
  async saveCapture(name = 'Capture') {
   if (status().busy || disposed) throw Error('Stop acquisition first')
   pending++; storageBusy = true; let id
   try {
    id = await archive.begin(name)
    for (const block of store.blocks) await archive.append(id, block)
    await archive.finish(id); host.storage.set('saved-capture', { id }); return id
   } catch (e) { if (id) await archive.remove(id); throw e }
   finally { pending--; storageBusy = false; emit() }
  },
  async loadCapture(id = host.storage.get('saved-capture')?.id) {
   if (status().busy || disposed) throw Error('Stop acquisition first')
   if (!id) throw Error('No saved capture')
   const next = new BlockStore(); pending++; storageBusy = true
   try {
    for await (const block of archive.blocks(id)) next.append(block)
    const meta = (await archive.list()).find(row => row.id === id)
    if (!meta) throw Error('Capture not found'); next.evicted += meta.evicted || 0; store.import(next.export()); recordMode = 'wave'
   } finally { pending--; storageBusy = false; emit() }
  },
  async connect(port) { reconcileCapture(); if (disposed || capture || pending) throw Error('Power busy'); pending++; try { await dedicated.open(port, { baudRate: 1000000 }); try { await dedicated.setSignals?.({ dataTerminalReady: true, requestToSend: true }) } catch (e) { host.log?.('Power serial signal setup unavailable: ' + e.message) }; power = null; voltage = null } finally { pending--; emit() } },
  async disconnect() { reconcileCapture(); if (capture || pending) throw Error('Stop sampling first'); await dedicated.close(); power = null },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
  setVoltage(lane, mv, context) { if (!Number.isInteger(mv) || mv < 500 || mv > 5000) return Promise.reject(Error('Voltage must be 500–5000 mV')); return operation(lane, async ({ send }) => { if (capture && capture.lane !== lane) throw Error('Capture owns another lane'); await send(BLU.cmdRegulatorSet(mv)); voltage = mv }, context) },
  setPower(lane, on, mv = 3300, context) {
   if (typeof on !== 'boolean' || !Number.isInteger(mv) || mv < 500 || mv > 5000) return Promise.reject(Error('Invalid power settings'))
   return operation(lane, async ({ send }) => { if (on) { await send(BLU.cmdRegulatorSet(mv)); voltage = mv } try { await send(BLU.cmdDutPower(on)); power = on } catch (cause) { throw Object.assign(Error(`DUT power outcome unknown${on ? '; regulator voltage applied: ' + mv + ' mV' : ''}: ${cause.message}`, { cause }), { stage: 'dut-power', voltageApplied: on ? mv : null, outcome: 'partial-or-unknown' }) } }, context)
  },
  start(lane, { rateHz = 100000, metadata = '', trigger = {}, durable = false, budgetBytes = 128_000_000, rolling = false, name = 'Live capture', mode = 'wave', warmupSeconds = 0 } = {}, context) {
   if (!Number.isFinite(rateHz) || rateHz <= 0 || rateHz > 100000) return Promise.reject(Error('Invalid sample rate'))
   return operation(lane, async ({ session, generation, send }) => {
    if (capture || archivePending) throw Error('Already sampling or archive still draining')
    if (!['wave', 'long'].includes(mode) || mode === 'long' && durable) throw Error('Long statistics mode does not store waveforms; choose RAM storage')
    if (!Number.isFinite(warmupSeconds) || warmupSeconds < 0 || warmupSeconds > 1) throw Error('Warmup must be 0–1 seconds')
    const nextGate = new CaptureGate({ ...trigger, warmupSamples: Math.min(5000, Math.round(rateHz * warmupSeconds)) })
    if (durable && (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1024 || budgetBytes > 2_000_000_000)) throw Error('Disk budget must be 1 KB–2 GB')
    if (durable) await archive.open()
    archivedId = null
    let archiveResolve, archiveReject
    const archiveReady = durable ? new Promise((resolve, reject) => { archiveResolve = resolve; archiveReject = reject }) : Promise.resolve(null)
    archiveReady.catch(() => {})
    archiveError = null; gate = nextGate
    const release = session.claim(owner), parser = new BLU.SampleParser(new BLU.Converter(BLU.parseMetadata(metadata)))
    const rate = new BLU.RateAdjuster(rateHz, 100000)
    let index = 0, outputIndex = 0, previousLost = 0, previousDrop = 0
    const off = session.subscribe(row => {
     if (row.generation !== generation) { reconcileCapture(); emit(); return }
     if (row.direction !== 'rx') return
     if (rawBuffer && rawLength < rawBuffer.length) { const n = Math.min(row.bytes.length, rawBuffer.length - rawLength); rawBuffer.set(row.bytes.subarray(0, n), rawLength); rawLength += n }
     const values = [], times = [], before = parser.lostSamples
     const samples = parser.push(row.bytes)
     parserStats = Object.fromEntries(['lostSamples', 'droppedBytes', 'badSamples', 'resyncCount', 'counterOk', 'lockMask'].map(key => [key, parser[key]]))
     const lost = parser.lostSamples - before; index += lost
     for (const sample of samples) {
      const time = index++ / 100000
      for (const value of rate.push(sample.iUA, time * 1000)) for (const [v, t] of gate.push(value.iUA, value.tMs / 1000)) { values.push(v); times.push(t); outputIndex++ }
     }
     if (values.length) { const block = { values: Float32Array.from(values), times: Float64Array.from(times), unit: 'µA', voltageMv: voltage, rateHz: rate.appliedRateHz(), gaps: parser.lostSamples !== previousLost || parser.droppedBytes !== previousDrop ? [{ beforeSample: outputIndex - values.length, lostSamples: lost, droppedBytes: parser.droppedBytes - previousDrop }] : [] }; totals.append(block); if (recordMode === 'wave') { store.append(block); const now = performance.now(), last = times.at(-1); for (const time of times) anchors.note(time, now + (time - last) * 1000); anchors.pruneBefore(store.blocks[0]?.times[0]) }
      if (durable && !archiveError) {
       if (archivePending >= 8) archiveError = 'Capture disk writer cannot keep up; acquisition stopped'
       else {
        archivePending++
        archiveQueue = archiveQueue.then(async () => { if (!archiveError) await archive.append(await archiveReady, block) }).catch(e => { archiveError = e.message; gate.phase = 'stopped'; if (capture) api.stop(lane).catch(e => { archiveError += '; stop: ' + e.message; emit() }) }).finally(() => { archivePending--; emit() })
       }
      }
     }
     if ((gate.phase === 'stopped' || archiveError) && capture && !capture.stopping) { capture.stopping = true; api.stop(lane).catch(e => { if (capture) capture.stopping = false; archiveError = e.message; emit() }) }
     previousLost = parser.lostSamples; previousDrop = parser.droppedBytes
     emit() // one event per RX block, never per sample
    })
    capture = { off, release, lane, session, generation }
    offEvents = ['A', 'B'].filter(id => id !== lane).map(id => host.session(id).subscribe(row => { if (!capture || recordMode !== 'wave' || !['rx', 'tx'].includes(row.direction)) return; eventRows.push({ lane: id, direction: row.direction, perf: performance.now(), sequence: row.sequence, hex: Array.from(row.bytes.subarray(0, 32), b => b.toString(16).padStart(2, '0')).join(' '), bytes: row.bytes.length }); if (eventRows.length > 5000) { eventRows.shift(); eventsDropped++ } }))
    let startWritten = false
    try {
     await send(BLU.cmdAverageStart(), () => { store.clear(); recordMode = mode; totals = new CaptureStatistics(); rawLength = 0; parserStats = {}; anchors.reset(); eventRows = []; eventsDropped = 0 }); startWritten = true
     if (durable) { archivedId = await archive.begin(name, { budgetBytes, rolling }); archiveResolve(archivedId) }
    } catch (e) {
     archiveReject?.(e); archiveError = e.message
     // A journal failure after START must send STOP and retain the capture on stop failure.
     if (startWritten && durable && archivedId == null) {
      try { await send(BLU.cmdAverageStop()) } catch (stopError) { archiveError += '; stop: ' + stopError.message; throw e }
     }
     off(); stopEvents(); await archiveQueue; if (archivedId) await archive.finish(archivedId, 'error'); release(); capture = null; throw e
    }
   }, context)
  },
  stop(lane, context) { reconcileCapture(); if (!capture) return Promise.resolve(); return operation(lane, async ({ send }) => { if (capture && capture.lane !== lane) throw Error('Wrong capture lane'); await stopCapture(send) }, context) },
  probePower(lane, metadata = '') {
   return operation(lane, async ({ session, generation, send }) => {
    if (capture) throw Error('Stop sampling before power probe')
    const release = session.claim(owner), parser = new BLU.SampleParser(new BLU.Converter(BLU.parseMetadata(metadata))), values = []
    const off = session.subscribe(row => { if (row.direction !== 'rx' || row.generation !== generation) return; for (const sample of parser.push(row.bytes)) if (values.length < 100000) values.push(sample.iUA) })
    capture = { off, release, lane, session, generation }
    let started = false
    try { await send(BLU.cmdAverageStart()); started = true; await new Promise(resolve => setTimeout(resolve, 250)); await send(BLU.cmdAverageStop()) }
    catch (e) { power = null; if (!started) { off(); release(); capture = null }; throw e }
    off(); release(); capture = null; values.sort((a, b) => a - b)
    const medianUA = values[values.length >> 1]; power = values.length >= 200 ? medianUA >= .5 : null
    return { on: power, medianUA, samples: values.length, source: 'probed' }
   })
  },
  metadata(lane) {
   return operation(lane, async ({ session, generation }) => {
    if (capture) throw Error('Stop sampling before reading calibration')
    return session.transaction(owner, async scope => {
     let text = ''
     return new Promise((resolve, reject) => {
      const abort = () => { off(); reject(Error('Metadata request cancelled')) }
      const finish = () => scope.signal.removeEventListener('abort', abort)
      const off = scope.subscribe(row => { if (row.direction !== 'rx') return; text += new TextDecoder().decode(row.bytes); if (text.length > 65536) { off(); finish(); reject(Error('Metadata too large')) } else if (text.includes('END')) { off(); finish(); resolve(text) } })
      scope.signal.addEventListener('abort', abort, { once: true })
      scope.send(BLU.cmdMeta()).catch(e => { off(); finish(); reject(e) })
     })
    }, { signal: host.signal, timeoutMs: 3000 })
   })
  },
  async dispose() {
   disposed = true
   await queue
   if (capture) {
    const active = capture
    if (active.session.generation === active.generation) await active.session.send(BLU.cmdAverageStop(), { owner, generation: active.generation })
    else if (['closing', 'cleanup-needed'].includes(active.session.state)) throw Error('Capture connection is still draining')
    active.off(); stopEvents(); await archiveQueue; if (archivedId) await archive.finish(archivedId, archiveError ? 'error' : 'saved'); active.release(); capture = null
   }
   await archiveQueue
   if (archivedId && capture) await archive.finish(archivedId, archiveError ? 'error' : 'saved')
   archive.close(); stopEvents()
   await host.resources.releaseSession('instrument')
   listeners.clear()
  },
 }
 return api
}
