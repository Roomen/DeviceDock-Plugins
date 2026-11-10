import 'fake-indexeddb/auto'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const hostPath = process.env.DEVICEDOCK_TEST_HOST, protocolsPath = process.env.DEVICEDOCK_TEST_PROTOCOLS
if (!hostPath || !protocolsPath) throw Error('Set DEVICEDOCK_TEST_HOST and DEVICEDOCK_TEST_PROTOCOLS (test-only sibling checkouts)')
const hostBase = resolve(hostPath) + '/', protocolBase = resolve(protocolsPath) + '/'
const { ExtensionHost } = await import(pathToFileURL(hostBase + 'src/extensions.js'))
const { Session } = await import(pathToFileURL(hostBase + 'src/session.js'))
const { verifyPackage } = await import(pathToFileURL(hostBase + 'src/package.js'))
const { validateCatalog } = await import(pathToFileURL(hostBase + 'src/sources.js'))
const { firmwareCodec } = await import(pathToFileURL(protocolBase + 'packages/sek/firmware.js'))
const { PCP, PCPMessageCode: codes } = await import(pathToFileURL(protocolBase + 'packages/sek/pcp.js'))
class Element extends EventTarget {
 constructor(doc) { super(); this.ownerDocument = doc; this.children = []; this.files = []; this.value = ''; this.style = {} }
 append(el) { this.children.push(el); el.parent = this }
 remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this) }
 setAttribute() {} replaceChildren() { this.children = [] } getContext() { return null }
}
const doc = { createElement: () => new Element(doc) }, memory = new Map()
const storage = { getItem: key => memory.get(key) || null, setItem: (key, value) => memory.set(key, value) }
const host = new ExtensionHost({ sessions: { A: new Session('A'), B: new Session('B') }, mount: doc.createElement(), storage })
const distribution = resolve(import.meta.dirname, '../dist') + '/'
const catalog = JSON.parse(await readFile(distribution + 'catalog.json')); validateCatalog(catalog, 'plugin')
const mobileHost = new ExtensionHost({ sessions: { A: new Session('A'), B: new Session('B') }, mount: doc.createElement(), storage, platform: 'mobile' })
for (const entry of catalog.packages) {
 const bundle = JSON.parse(await readFile(distribution + entry.artifact)); await verifyPackage(bundle, 'web')
 if (['org.devicedock.power', 'org.devicedock.bridge'].includes(entry.id)) {
  await assert.rejects(verifyPackage(bundle, 'mobile'), /不支持/)
  await assert.rejects(mobileHost.enable(bundle.manifest, 'file:///test-only.js', true), /不支持/)
 } else await verifyPackage(bundle, 'mobile')
 const url = pathToFileURL(distribution + entry.id + '/' + bundle.manifest.entry).href
 await host.enable(bundle.manifest, url, true)
}
function port(write = () => {}) {
 let rx
 return { readable: null, writable: null, async open() { this.readable = new ReadableStream({ start(c) { rx = c } }); this.writable = new WritableStream({ write }) }, push(bytes) { rx.enqueue(bytes) }, async setSignals(signals) { this.signals = signals }, async close() {} }
}
// Activation above registers all packaged MCP definitions through the real host validator.
assert.ok([...host.mcpTools.keys()].some(name => name.endsWith('.blu_capture_start')))
assert.equal(host.mcpTools.get('org.devicedock.firmware.upgrade_library_original').definition.timeoutMs, 1260000)
assert.ok(host.mcpTools.has('org.devicedock.bridge.ble_write'))
// Actual host send reacquires the replacement writable after a recoverable sink failure.
const { createStreamPort } = await import(pathToFileURL(distribution + 'org.devicedock.wireless/shared/stream-port.js'))
let rejectWrite = true; const delivered = []
const recovering = createStreamPort({ async open() {}, async write(bytes) { if (rejectWrite) { rejectWrite = false; throw Error('synthetic recoverable write') }; delivered.push([...bytes]) }, async setSignals(signals) { this.signals = signals }, async close() {} })
const recoverySession = new Session('recovery')
await recoverySession.open(recovering, {})
await assert.rejects(recoverySession.send(Uint8Array.of(1)), /recoverable/)
await recoverySession.send(Uint8Array.of(2)); assert.deepEqual(delivered, [[2]])
await recoverySession.close(); assert.equal(recovering.state, 'closed')
// Actual host Session close records release power capture only after physical drain.
const powerWrites = [], power = host.services.get('org.devicedock.power.v1'), instrument = port(bytes => powerWrites.push([...bytes]))
await power.connect(instrument); assert.deepEqual(instrument.signals, { dataTerminalReady: true, requestToSend: true });
const powerTool = host.mcpTools.get('org.devicedock.power.blu_set_voltage'), powerContext = { signal: new AbortController().signal, snapshot: { document: 'integration', lanes: {} }, commit: async () => { assert.equal(host.resources.get('org.devicedock.power.instrument').busy, true); assert.equal(powerWrites.length, 0) } }
await powerTool.call({ lane: 'instrument', millivolts: 3300 }, powerContext); assert.equal(powerWrites.length, 1)
await assert.rejects(powerTool.call({ lane: 'instrument', millivolts: 3200 }, { ...powerContext, commit: async () => { throw Error('expired actual fence') } }), /expired actual fence/); assert.equal(powerWrites.length, 1)
await power.start('instrument')
await host.resources.get('org.devicedock.power.instrument').close()
assert.equal(power.status().sampling, false)
await power.stop('instrument'); const unsupportedPower = port(); delete unsupportedPower.setSignals; await power.connect(unsupportedPower); assert.equal(host.resources.get('org.devicedock.power.instrument').state, 'open'); await power.disconnect()
await host.disable('org.devicedock.power')
// Actual SEK parser/builders + actual host transaction, zero hardware.
host.services.set('org.devicedock.sek.firmware.v1', firmwareCodec)
const firmware = host.services.get('org.devicedock.firmware.v1'), sent = []
const serial = port(bytes => {
 const decoded = PCP.parseMessage(bytes); assert.equal(decoded.checksumValid, true); sent.push(decoded)
 if (decoded.messageCode === codes.QUERY_VERSION) serial.push(PCP.buildMessage(codes.QUERY_VERSION, [0, ...PCP.versionToBytes('V0')]))
 if (decoded.messageCode === codes.NEW_VERSION_NOTIFY) {
  const chunks = [PCP.buildMessage(codes.NEW_VERSION_NOTIFY, [0]), PCP.buildMessage(codes.DOWNLOAD_REQUEST, [...PCP.versionToBytes('V1.2.3'), 0, 32]), PCP.buildMessage(codes.DOWNLOAD_RESULT, [0])]
  const all = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0)); let off = 0; for (const b of chunks) { all.set(b, off); off += b.length }; serial.push(all)
 }
})
await host.sessions.A.open(serial, { baudRate: 115200 })
const raw = new Uint8Array(0x4020); raw.set(new TextEncoder().encode('V1.2.3'), 0x4004)
const packageBytes = await firmware.package('origin', raw)
const result = await firmware.upgrade('A', packageBytes, { chunkSize: 512, replyDelayMs: 0 })
assert.equal(result.executed, true); assert.equal(result.verified, false)
const response = sent.find(m => m.messageCode === codes.DOWNLOAD_REQUEST); assert.equal(response.data.length, 515); assert.equal(response.data.at(-1), 255)
const cancellation = firmware.upgrade('A', packageBytes, { chunkSize: 512, replyDelayMs: 0 })
const expectedCancellation = assert.rejects(cancellation, /cancel|取消/)
await new Promise(resolve => setTimeout(resolve, 10)); firmware.cancel(); await expectedCancellation
assert.equal(host.sessions.A.busy, false)
await host.sessions.A.close(); await host.disable('org.devicedock.firmware')
// USB bridge service uses the original NDJSON ping/scan protocol over owned host session.
const bridge = host.services.get('org.devicedock.bridge.v1')
const usb = port(bytes => {
 const command = JSON.parse(new TextDecoder().decode(bytes))
 const reply = {t:'rsp',id:command.id,ok:true}
 usb.push(new TextEncoder().encode(JSON.stringify(reply) + '\n'))
 if (command.op === 'ping') usb.push(new TextEncoder().encode('{"t":"evt","e":"ready"}\n'))
 if (command.op === 'scan.start') usb.push(new TextEncoder().encode('{"t":"evt","e":"scan","state":"scanning"}\n'))
})
const unsupportedBridge = port(); delete unsupportedBridge.setSignals; await assert.rejects(bridge.controller.run('open', { deviceId: bridge.selectPort(unsupportedBridge) }), /不支持|support/); assert.equal(host.resources.has('org.devicedock.bridge.bridge'), false)
const bridgeId = bridge.selectPort(usb); await bridge.controller.run('open', { deviceId: bridgeId })
assert.deepEqual(usb.signals, { dataTerminalReady: false, requestToSend: false })
await bridge.controller.run('scan_start'); assert.equal(bridge.controller.state().scanning, true)
await assert.rejects(host.disable('org.devicedock.bridge'), /Stop scanning/)
await bridge.controller.run('scan_stop'); await bridge.controller.run('close')
await host.disable('org.devicedock.bridge'); await host.disable('org.devicedock.wireless'); await host.disable('org.devicedock.patch')
assert.equal(host.extensions.size, 0); assert.equal(host.resources.size, 0); assert.equal(host.mount.children.length, 0)
console.log('PASS: actual host verifies five bundles/catalog and rejects power/bridge on mobile; real host writable recovery and close recover power; real SEK PCP transfer/cancellation ownership and full lifecycle use exact SDK')
