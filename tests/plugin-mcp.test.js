import 'fake-indexeddb/auto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mockHost, deferred, tick } from './helpers.js'
import { createPowerService } from '../plugins/power/service.js'
import { registerPowerTools } from '../plugins/power/mcp.js'
import { createFirmwareService } from '../plugins/firmware/service.js'
import { createBridgeService } from '../plugins/bridge/service.js'
import { registerBridgeTools } from '../plugins/bridge/mcp.js'
import { registerFirmwareTools } from '../plugins/firmware/mcp.js'
const validator = process.env.DEVICEDOCK_TEST_HOST ? await import(pathToFileURL(resolve(process.env.DEVICEDOCK_TEST_HOST, 'src/schema.js'))) : null
function tools(host) {
 const map = new Map(); host.registerMcpTool = (definition, call) => { validator?.validateSchema(definition.inputSchema); map.set(definition.name, { definition, call }); return () => map.delete(definition.name) }; return map
}
function context(host, overrides = {}) { return { signal: new AbortController().signal, commit: async () => {}, snapshot: { document: 'fixture', lanes: Object.fromEntries(['A','B'].map(lane => [lane, { generation: host.sessions[lane].generation, state: host.sessions[lane].state }])) }, ...overrides } }
test('typed legacy power adapters validate arguments and expose no arbitrary service lifecycle', async () => {
 const host = mockHost(), map = tools(host), service = createPowerService(host), off = registerPowerTools(host, service)
 assert.equal(map.size, 6); assert.equal(map.has('org.devicedock.power.dispose'), false)
 const voltage = map.get('org.devicedock.power.blu_set_voltage').call, power = map.get('org.devicedock.power.blu_set_power').call
 await assert.rejects(power({ lane: 'A', on: true }, context(host)), /regulator voltage/)
 await assert.rejects(voltage({ lane: 'A', millivolts: '3300' }, context(host)), /integer/)
 await assert.rejects(voltage({ lane: 'A', millivolts: 3300, arbitrary: 1 }, context(host)), /arguments/)
 let committed = 0
 await voltage({ lane: 'A', millivolts: 3300 }, context(host, { commit: async () => { committed++; assert.equal(host.sessions.A.busy, true); assert.equal(host.sessions.A.writes.length, 0) } }))
 assert.equal(committed, 1); await power({ lane: 'A', on: true }, context(host)); assert.equal(service.status().power, true)
 off(); assert.equal(map.size, 0); await service.dispose()
})
test('expired/stale queued power request never commits or executes; two-step power commits once', async () => {
 const host = mockHost(), service = createPowerService(host), gate = deferred(), session = host.sessions.A
 session.onSend = () => gate.promise
 const first = service.setVoltage('A', 3000); await tick()
 const controller = new AbortController(); let commits = 0
 const expired = service.setPower('A', true, 3300, context(host, { signal: controller.signal, commit: async () => { commits++ } })); const rejection = assert.rejects(expired, /abort/i)
 controller.abort(); gate.resolve(); await first; await rejection; assert.equal(commits, 0); assert.equal(session.writes.length, 1)
 session.onSend = null
 await service.setPower('A', true, 3300, context(host, { commit: async () => { commits++ } })); assert.equal(commits, 1)
 const stale = context(host); session.generation++; await assert.rejects(service.setVoltage('A', 3300, stale), /connection changed/)
 const before = session.writes.length
 await assert.rejects(service.setPower('A', false, 3300, context(host, { commit: async () => { throw Error('fence expired') } })), /fence expired/)
 assert.equal(session.writes.length, before); await service.dispose()
})
test('capture fence rejection leaves no cleared data, journal or I/O', async () => {
 const host = mockHost(), service = createPowerService(host), session = host.sessions.A
 service.store.append({ times: Float64Array.of(0), values: Float32Array.of(2), rateHz: 1, unit: 'µA' })
 await assert.rejects(service.start('A', { durable: true }, context(host, { commit: async () => { throw Error('not executed') } })), /not executed/)
 assert.equal(service.store.samples, 1); assert.equal(session.writes.length, 0); assert.equal((await service.captures()).length, 0); assert.equal(session.busy, false)
 await service.dispose()
})
test('firmware typed query uses commit at write and cancellation prevents execute', async () => {
 const host = mockHost(), map = tools(host), fw = createFirmwareService(host), off = registerFirmwareTools(host, fw)
 host.services.set('org.devicedock.sek.firmware.v1', { apiVersion: 1, codes: { queryVersion: 1 }, create: () => ({ feed: b => [{ code: b[0], bytes: b }], reset() {} }), queryVersion: () => Uint8Array.of(10), parseVersion: () => ({ resultCode: 0, version: 'V1' }) })
 const call = map.get('org.devicedock.firmware.query_version').call; let commits = 0
 host.sessions.A.onSend = () => host.sessions.A.emit(Uint8Array.of(1))
 assert.equal(await call({ lane: 'A' }, context(host, { commit: async () => { commits++; assert.equal(host.sessions.A.writes.length, 0) } })), 'V1'); assert.equal(commits, 1)
 await assert.rejects(call({ lane: 'A' }, context(host, { commit: async () => { throw Error('expired') } })), /expired/); assert.equal(host.sessions.A.writes.length, 1)
 off(); assert.equal(map.size, 0); await fw.dispose()
})

test('two-step power failure reports applied voltage and unknown power outcome', async () => {
 const host = mockHost(), service = createPowerService(host)
 let writes = 0; host.sessions.A.onSend = () => { if (++writes === 2) throw Error('link lost') }
 await assert.rejects(service.setPower('A', true, 3200, context(host)), e => e.stage === 'dut-power' && e.voltageApplied === 3200 && e.outcome === 'partial-or-unknown' && /3200/.test(e.message))
 assert.equal(service.status().voltage, 3200); assert.equal(service.status().power, null); await service.dispose()
})

test('bridge MCP declares legacy commands and commits at host write; expired queued work never writes', async () => {
 const host = mockHost(), map = tools(host), service = createBridgeService(host), off = registerBridgeTools(host, service)
 assert.equal(map.size, 16); const id = service.selectPort({})
 // The actual controller protocol runs through a dedicated host resource session.
 const create = host.resources.createSession.bind(host.resources)
 host.resources.createSession = key => { const session = create(key); session.onSend = bytes => { const cmd = JSON.parse(new TextDecoder().decode(bytes)); session.emit(new TextEncoder().encode(JSON.stringify({ t: 'rsp', id: cmd.id, ok: true }) + '\n')) }; return session }
 let commits = 0
 await map.get('org.devicedock.bridge.ble_open').call({ deviceId: id }, context(host, { commit: async () => { commits++ } })); assert.equal(commits, 1)
 const session = host.resourcesMap.get('bridge'); assert.equal(session.writes.length, 1)
 await assert.rejects(map.get('org.devicedock.bridge.ble_scan_start').call({}, context(host, { commit: async () => { assert.equal(session.writes.length, 1); throw Error('fence expired') } })), /fence expired/)
 assert.equal(session.writes.length, 1); off(); await service.dispose()
})
