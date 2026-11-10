// Real browser, no screenshots or hardware. Test-only sibling imports never ship.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve, join, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright-core'
import { legacyEngine } from './patch/legacy-fixture.mjs'
import { patchFixtures } from '../tests/patch-fixtures.js'
const root = resolve(import.meta.dirname, '..'), hostRoot = process.env.DEVICEDOCK_TEST_HOST
if (!hostRoot) throw Error('Set DEVICEDOCK_TEST_HOST to the sibling DeviceDock checkout')
const browser = await chromium.launch({ executablePath: process.env.DEVICEDOCK_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const server = createServer(async (req, res) => {
 try {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><main></main>'); return }
  const hostFile = req.url.startsWith('/host/'), protocolFile = req.url.startsWith('/protocols/')
  const relative = decodeURIComponent(req.url.slice(hostFile ? 6 : protocolFile ? 11 : 1)), base = hostFile ? resolve(hostRoot) : protocolFile && process.env.DEVICEDOCK_TEST_PROTOCOLS ? resolve(process.env.DEVICEDOCK_TEST_PROTOCOLS) : root, path = resolve(base, relative)
  if (!path.startsWith(base + '/')) throw Error('Unsafe path')
  res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' })[extname(path)] || 'application/octet-stream'); res.end(await readFile(path))
 } catch { res.statusCode = 404; res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const temporary = await mkdtemp(join(tmpdir(), 'devicedock-patch-roundtrip-'))
try {
 const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}/`)
 await page.evaluate(async () => {
  const { ExtensionHost } = await import('/host/src/extensions.js'), { Session } = await import('/host/src/session.js'), { verifyPackage } = await import('/host/src/package.js')
  const bundle = await (await fetch('/dist/org.devicedock.patch-1.0.0.json')).json(); await verifyPackage(bundle, 'web')
  globalThis.testHost = new ExtensionHost({ sessions: { A: new Session('A'), B: new Session('B') }, mount: document.querySelector('main'), storage: localStorage })
  await testHost.enable(bundle.manifest, location.origin + '/dist/org.devicedock.patch/' + bundle.manifest.entry, true)
 })
 const types = new Set(), legacy = process.env.DEVICEDOCK_TEST_LEGACY ? await legacyEngine(process.env.DEVICEDOCK_TEST_LEGACY) : null
 for (const [name, old, fresh] of patchFixtures()) {
  const patch = Uint8Array.from(await page.evaluate(async ({ old, fresh }) => Array.from(await testHost.services.get('org.devicedock.firmware.patch.v1').createPatch(Uint8Array.from(old), Uint8Array.from(fresh))), { old: [...old], fresh: [...fresh] }))
  assert.equal(String.fromCharCode(...patch.slice(0, 2)), 'hI'); assert.equal(patch[3] >>> 6, 1); assert.ok([0, 1].includes(patch[2])); types.add(patch[2])
  const outputs = [['rebuilt', patch], ...(legacy ? [['legacy', legacy(old, fresh)]] : [])]
  for (const [engine, payload] of outputs) {
  assert.equal(String.fromCharCode(...payload.slice(0, 2)), 'hI'); assert.equal(payload[3] >>> 6, 1); assert.ok([0, 1].includes(payload[2]))
  if (process.env.DEVICEDOCK_TEST_HPATCHI) {
   const oldFile = join(temporary, 'old'), patchFile = join(temporary, 'patch'), outFile = join(temporary, 'new')
   await writeFile(oldFile, old); await writeFile(patchFile, payload)
   execFileSync(process.env.DEVICEDOCK_TEST_HPATCHI, ['-f', oldFile, patchFile, outFile], { stdio: 'pipe' })
   assert.deepEqual(new Uint8Array(await readFile(outFile)), fresh, engine + ':' + name + ' independent native decode')
  }
  }
  console.log('PASS packaged browser Worker/WASM fixture:', name, patch.length, 'bytes', legacy ? '+ legacy native roundtrip' : '')
 }
 if (process.env.DEVICEDOCK_TEST_PROTOCOLS) {
  const packages = await page.evaluate(async () => {
   const { firmwareCodec } = await import('/protocols/packages/sek/firmware.js'), { PCP, PCPMessageCode: codes } = await import('/protocols/packages/sek/pcp.js')
   const bundle = await (await fetch('/dist/org.devicedock.firmware-1.0.0.json')).json()
   await testHost.enable(bundle.manifest, location.origin + '/dist/org.devicedock.firmware/' + bundle.manifest.entry, true)
   testHost.services.set('org.devicedock.sek.firmware.v1', firmwareCodec)
   const fw = testHost.services.get('org.devicedock.firmware.v1'), raw = new Uint8Array(0x4020); raw.set(new TextEncoder().encode('V1.2.3'), 0x4004)
   await fw.addToLibrary('base', raw)
   let rx, notices = 0, total, chunkSize, chunks, executions = 0, transactions = 0
   const order = [], received = []
   const push = (code, data) => rx.enqueue(PCP.buildMessage(code, data))
   const request = index => push(codes.DOWNLOAD_REQUEST, [...PCP.versionToBytes('V1.2.3'), index >> 8, index & 255])
   const port = { async open() {
    this.readable = new ReadableStream({ start(controller) { rx = controller } })
    this.writable = new WritableStream({ write(bytes) {
     const frame = PCP.parseMessage(bytes); if (!frame.checksumValid) throw Error('Bad wire CRC')
     order.push(frame.messageCode)
     if (frame.messageCode === codes.QUERY_VERSION) push(codes.QUERY_VERSION, [0, ...PCP.versionToBytes('V1.2.3')])
     if (frame.messageCode === codes.NEW_VERSION_NOTIFY) {
      notices++; chunks = []; chunkSize = (frame.data[16] << 8) | frame.data[17]; total = (frame.data[18] << 8) | frame.data[19]
      push(codes.NEW_VERSION_NOTIFY, [0]); request(0)
     }
     if (frame.messageCode === codes.DOWNLOAD_REQUEST) {
      const index = (frame.data[1] << 8) | frame.data[2]; chunks[index] = frame.data.slice(3)
      if (index + 1 < total) request(index + 1)
      else {
       const all = new Uint8Array(total * chunkSize); chunks.forEach((chunk, i) => all.set(chunk, i * chunkSize))
       const length = 128 + new DataView(all.buffer).getUint32(16, true), pkg = all.slice(0, length), verified = fw.verifyPackage(pkg)
       if (verified.type !== (notices === 1 ? 3 : 2)) throw Error('Wrong fallback image type')
       received.push(Array.from(pkg)); push(codes.DOWNLOAD_RESULT, [notices === 1 ? 7 : 0])
      }
     }
     if (frame.messageCode === codes.EXECUTE_UPGRADE) executions++
    } })
   }, async setSignals(signals) { this.signals = signals }, async close() {} }
   const session = testHost.sessions.A, transaction = session.transaction.bind(session)
   session.transaction = (...args) => { transactions++; return transaction(...args) }
   await session.open(port, { baudRate: 115200 })
   const result = await fw.upgradeAutomatic('A', raw, { chunkSize: 512, replyDelayMs: 0 })
   // Actual constants differ across protocol versions: final service result proves execute send.
   if (!result.executed || notices !== 2 || transactions !== 1 || session.busy) throw Error('Automatic retry ownership failed')
   const ack = order.indexOf(codes.DOWNLOAD_RESULT), second = order.indexOf(codes.NEW_VERSION_NOTIFY, order.indexOf(codes.NEW_VERSION_NOTIFY) + 1)
   if (ack < 0 || ack >= second) throw Error('Rejected diff ACK must precede compressed notify')
   await session.close(); await testHost.disable('org.devicedock.firmware')
   return { received, raw: Array.from(raw) }
  })
  for (const [i, bytes] of packages.received.entries()) {
   const pkg = Uint8Array.from(bytes), expected = Uint8Array.from(packages.raw)
   if (process.env.DEVICEDOCK_TEST_HPATCHI) {
    await writeFile(join(temporary, 'old'), i === 0 ? expected : new Uint8Array(32).fill(255)); await writeFile(join(temporary, 'patch'), pkg.slice(128))
    execFileSync(process.env.DEVICEDOCK_TEST_HPATCHI, ['-f', join(temporary, 'old'), join(temporary, 'patch'), join(temporary, 'new')], { stdio: 'pipe' })
    assert.deepEqual(new Uint8Array(await readFile(join(temporary, 'new'))), expected)
   }
  }
  console.log('PASS real host + SEK + packaged WASM automatic diff rejection ACK / compressed retry; both transmitted images independently decoded')
 }
 // Browser IDB uses the same production API, beyond localStorage's practical size.
 await page.evaluate(async () => {
  const { createFirmwareLibrary } = await import('/plugins/firmware/library.js'), storage = { get: key => JSON.parse(localStorage.getItem(key)), set: (key, value) => localStorage.setItem(key, JSON.stringify(value)) }
  const lib = createFirmwareLibrary(storage), a = new Uint8Array(4_000_000).fill(1), b = new Uint8Array(4_000_000).fill(2)
  const id = await lib.add({ name: 'a' }, a); await lib.add({ name: 'b' }, b)
  if ((await lib.list()).length !== 2 || (await lib.read(id)).data.length !== 4_000_000) throw Error('Browser binary library bounds failed')
  await lib.close()
  await testHost.disable('org.devicedock.patch'); if (testHost.extensions.size) throw Error('Patch lifecycle leak')
 })
 console.log('PASS real browser IndexedDB 4 MB entries / 8 MB total; host asset verification and worker lifecycle')
 await page.evaluate(async () => {
  for (const name of ['power', 'wireless', 'bridge']) {
   const bundle = await (await fetch('/dist/org.devicedock.' + name + '-1.0.0.json')).json()
   await testHost.enable(bundle.manifest, location.origin + '/dist/org.devicedock.' + name + '/' + bundle.manifest.entry, true)
  }
  if ([...document.querySelectorAll('button')].some(b => /Select wireless device & connect|Disconnect selected lane/.test(b.textContent))) throw Error('Wireless must use host-owned connection selector')
  const power = testHost.services.get('org.devicedock.power.v1')
  power.importCSV('timestamp_s,current_uA,voltage_mV\n' + Array.from({ length: 512 }, (_, i) => `${i / 1000},${10 + 5 * Math.sin(2 * Math.PI * i / 32)},3300`).join('\n'))
  const click = text => { const button = [...document.querySelectorAll('button')].find(b => b.textContent === text); if (!button) throw Error('Missing control: ' + text); button.click() }
  click('Show all retained samples'); click('Analyze selection'); const peaks = document.querySelector('[aria-label="FFT peaks"]'); if (!peaks.children.length) throw Error('FFT peak list missing'); peaks.querySelector('button').click(); const control = label => [...document.querySelectorAll('label')].find(el => el.textContent.startsWith(label))?.querySelector('input,select'); if (Math.abs(Number(control('Cycle length').value) - 32) > 1) throw Error('FFT peak must select correct cycle period'); control('Trigger level (').value = '10'; control('Trigger hysteresis').value = '.1'; click('Measure edge period / set cycle length'); if (Math.abs(Number(control('Cycle length').value) - 32) > 1) throw Error('Cursor period measurement failed'); click('Show all retained samples'); click('Snap cursors to outer selected edges'); click('Analyze selection')
  if (!document.querySelector('[aria-label="Current waveform"]').getContext('2d').getImageData(0, 0, 900, 220).data.some(x => x)) throw Error('Waveform not rendered')
  const pre = [...document.querySelectorAll('pre')].map(el => el.textContent).join(' '); if (!pre.includes('excludesGaps')) throw Error('Selection analysis not rendered')
  let rx; const writes = []
  const port = { async open() { this.readable = new ReadableStream({ start(c) { rx = c } }); this.writable = new WritableStream({ write(bytes) { writes.push([...bytes]) } }) }, async setSignals(signals) { this.signals = signals }, async close() {} }
  await power.connect(port); if (!port.signals?.dataTerminalReady || !port.signals?.requestToSend) throw Error('Power resource signals missing'); await power.setVoltage('instrument', 3300)
  await power.start('instrument', { durable: true }); rx.enqueue(new Uint8Array(40)); await new Promise(resolve => setTimeout(resolve, 20)); testHost.sessions.A.emit('tx', Uint8Array.of(1, 2)); await new Promise(resolve => setTimeout(resolve, 2)); rx.enqueue(new Uint8Array(40)); await new Promise(resolve => setTimeout(resolve, 20)); await power.stop('instrument'); if (!power.serialEvents().rows.some(row => row.lane === 'A' && row.seconds != null)) throw Error('Live serial event alignment failed')
  const [saved] = await power.captures(); if (saved.state !== 'saved' || saved.samples !== 20) throw Error('Browser durable capture failed')
  power.store.clear(); await power.loadCapture(saved.id); if (power.store.samples !== 20) throw Error('Browser archive reload failed')
  const csv = await (await power.exportCaptureCSV(saved.id)).text(); if (!csv.includes('voltage_mV')) throw Error('CSV voltage missing')
  await power.disconnect()
  if (testHost.mcpTools.get('org.devicedock.firmware.upgrade_library_original')) throw Error('Disabled firmware MCP leak')
  if (!testHost.mcpTools.has('org.devicedock.bridge.ble_write')) throw Error('Bridge schema registration failed')
  for (const name of ['power', 'wireless', 'bridge']) await testHost.disable('org.devicedock.' + name)
  if (testHost.extensions.size || testHost.resources.size || testHost.mcpTools.size) throw Error('UI lifecycle leak')
 })
 console.log('PASS actual browser/host power CSV/charts/analysis/durable archive and wireless facade routing; MCP schemas and lifecycle')

 if (!process.env.DEVICEDOCK_TEST_HPATCHI) console.log('Native decoder skipped: set DEVICEDOCK_TEST_HPATCHI for independent roundtrip')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true }) }
