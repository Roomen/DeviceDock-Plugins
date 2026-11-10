import 'fake-indexeddb/auto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import core from '../plugins/firmware/core.js'
import { createFirmwareService, verifyPackage } from '../plugins/firmware/service.js'
import { mockHost, tick } from './helpers.js'
function raw() { const bytes = new Uint8Array(0x4020); bytes.set(new TextEncoder().encode('V1.2.3'), 0x4004); return bytes }
function original() { const bytes = raw(); return core.joinPackage(core.packFirmware({ firmwareData: bytes, pkgType: 1 }), bytes) }
// A deliberately non-wire mock of the agreed codec service. Production bytes come only from SEK.
function codec() {
 return { apiVersion: 1, codes: { queryVersion: 1, newVersion: 2, downloadRequest: 3, downloadResult: 4 },
  create() { return { feed: bytes => [{ code: bytes[0], bytes: bytes.slice() }], reset() {} } },
  queryVersion: () => Uint8Array.of(10), parseVersion: () => ({ resultCode: 0, version: 'V0' }),
  notify: () => Uint8Array.of(20), parseNotify: () => ({ resultCode: 0 }),
  parseRequest: bytes => ({ chunkIndex: bytes[1] }), chunk: (index, data) => Uint8Array.of(30, index, ...data),
  parseResult: bytes => ({ downloadStatus: bytes[1] }), acknowledge: () => Uint8Array.of(40), execute: () => Uint8Array.of(50),
 }
}
test('firmware original byte fixture, CRC known vector and strict header/body verification', () => {
 assert.equal(core.crc32(new TextEncoder().encode('123456789')), 0xcbf43926)
 const pkg = original(); assert.deepEqual([...pkg.subarray(0, 12)], [83,101,99,107,0,0,0,0,1,0,0,0]); assert.equal(verifyPackage(pkg).version, 'V1.2.3')
 const badHeader = pkg.slice(); badHeader[76] ^= 1; assert.throws(() => verifyPackage(badHeader), /Header CRC/)
 const badBody = pkg.slice(); badBody[128] ^= 1; assert.throws(() => verifyPackage(badBody), /Data CRC/)
 assert.throws(() => verifyPackage(pkg.slice(0, -1)), /length/)
 assert.throws(() => verifyPackage(new Uint8Array(4)), /magic/)
})
test('service requires actual SEK capability and never invents device frames', async () => {
 const host = mockHost(), fw = createFirmwareService(host)
 await assert.rejects(fw.upgrade('A', original()), /SEK/); assert.equal(host.sessions.A.writes.length, 0); await fw.dispose()
})
test('transfer preserves early RX, repeated requests, padding, claim and progress', async () => {
 const host = mockHost(), s = host.sessions.A, fw = createFirmwareService(host), states = []
 host.services.set('org.devicedock.sek.firmware.v1', codec()); fw.subscribe(x => states.push(x))
 s.onSend = bytes => {
  assert.equal(s.busy, true)
  if (bytes[0] === 10) s.emit(Uint8Array.of(1))
  if (bytes[0] === 20) { s.emit(Uint8Array.of(2)); s.emit(Uint8Array.of(3, 32)); s.emit(Uint8Array.of(3, 32)); s.emit(Uint8Array.of(4, 0)) }
 }
 const outcome = await fw.upgrade('A', original(), { chunkSize: 512, replyDelayMs: 0 })
 assert.equal(outcome.verified, false); const chunks = s.writes.filter(b => b[0] === 30); assert.equal(chunks.length, 2); assert.equal(chunks[0].length, 514)
 assert.equal(chunks[0].at(-1), 255); assert.ok(states.some(x => x.resend)); assert.equal(s.busy, false); assert.equal(s.listeners.size, 0); assert.equal(s.writes.at(-1)[0], 50)
 await fw.dispose()
})
test('cancellation releases inbox and claim; unavailable package generator fails honestly', async () => {
 const host = mockHost(), fw = createFirmwareService(host), s = host.sessions.A; host.services.set('org.devicedock.sek.firmware.v1', codec())
 const pending = fw.upgrade('A', original()); const expected = assert.rejects(pending, /cancelled/)
 await tick(); assert.equal(s.busy, true); fw.cancel(); await expected; assert.equal(s.busy, false); assert.equal(s.listeners.size, 0)
 await assert.rejects(fw.package('compress', raw()), /licensed/)
 const pkg = await fw.package('origin', raw()); assert.equal(verifyPackage(pkg).type, 1); await fw.dispose()
})
test('package planner never guesses an ambiguous differential baseline', async () => {
 assert.equal(core.planUpgrade({ deviceVersion: 'V0', candidates: [{ crc: 1, size: 1 }, { crc: 2, size: 1 }] }).mode, 'compress')
 const h = mockHost(), fw = createFirmwareService(h); await fw.addToLibrary('one.bin', raw()); await fw.addToLibrary('same.bin', raw()); assert.equal((await fw.library()).length, 1); await fw.dispose()
})
test('automatic upgrade retains one transaction through diff rejection ACK, compressed retry and execute', async () => {
 const host = mockHost(), s = host.sessions.A, fw = createFirmwareService(host), c = codec(), modes = [], built = [], states = []
 c.parseVersion = () => ({ resultCode: 0, version: 'V1.2.3' })
 host.services.set('org.devicedock.sek.firmware.v1', c)
 host.services.set('org.devicedock.firmware.patch.v1', { createPatch: async (old, fresh, { signal }) => { assert.equal(s.busy, true); assert.equal(signal.aborted, false); built.push(old.slice()); return Uint8Array.of(0x68, 0x49, built.length) } })
 await fw.addToLibrary('base', raw()); fw.subscribe(state => states.push(state))
 let notices = 0, transactions = 0
 const transaction = s.transaction.bind(s); s.transaction = (...args) => { transactions++; return transaction(...args) }
 s.onSend = bytes => {
  if (bytes[0] === 10) s.emit(Uint8Array.of(1))
  if (bytes[0] === 20) { notices++; modes.push(notices); s.emit(Uint8Array.of(2)); s.emit(Uint8Array.of(3, 0)); s.emit(Uint8Array.of(4, notices === 1 ? 7 : 0)) }
 }
 const outcome = await fw.upgradeAutomatic('A', raw(), { chunkSize: 512, replyDelayMs: 0 })
 assert.equal(outcome.executed, true); assert.equal(transactions, 1); assert.equal(built.length, 2); assert.deepEqual(built[0], raw()); assert.deepEqual(built[1], core.BLANK_BUILTIN)
 assert.deepEqual(s.writes.map(b => b[0]), [10,20,30,40,20,30,40,50]); assert.equal(states.filter(x => x.phase === 'fallback').length, 1); await fw.dispose()
})
test('automatic upgrade uses compression for ambiguous builds and never executes failed downloads', async () => {
 const host = mockHost(), s = host.sessions.A, fw = createFirmwareService(host), c = codec(), bases = []
 c.parseVersion = () => ({ resultCode: 0, version: 'V1.2.3' }); host.services.set('org.devicedock.sek.firmware.v1', c)
 host.services.set('org.devicedock.firmware.patch.v1', { createPatch: async old => { bases.push(old.slice()); return Uint8Array.of(1) } })
 const other = raw(); other[0] = 1
 await fw.addToLibrary('a', raw()); await fw.addToLibrary('b', other)
 s.onSend = bytes => { if (bytes[0] === 10) s.emit(Uint8Array.of(1)); if (bytes[0] === 20) { s.emit(Uint8Array.of(2)); s.emit(Uint8Array.of(4, 8)) } }
 await assert.rejects(fw.upgradeAutomatic('A', raw(), { replyDelayMs: 0 }), /Download failed/)
 assert.deepEqual(bases, [core.BLANK_BUILTIN]); assert.equal(s.writes.some(b => b[0] === 50), false); assert.equal(s.busy, false); await fw.dispose()
})
test('automatic cancellation while packaging preserves transaction ownership until provider settles', async () => {
 const host = mockHost(), fw = createFirmwareService(host), s = host.sessions.A, c = codec()
 const { deferred } = await import('./helpers.js'), gate = deferred(); let started = false
 host.services.set('org.devicedock.sek.firmware.v1', c)
 host.services.set('org.devicedock.firmware.patch.v1', { createPatch: async () => { started = true; return gate.promise } })
 s.onSend = bytes => { if (bytes[0] === 10) s.emit(Uint8Array.of(1)) }
 const pending = fw.upgradeAutomatic('A', raw()); const rejected = assert.rejects(pending, /cancelled/)
 while (!started) await tick(); fw.cancel(); await tick(); assert.equal(s.busy, true)
 gate.resolve(Uint8Array.of(1)); await rejected; assert.equal(s.busy, false); assert.equal(s.writes.some(b => b[0] === 50), false); await fw.dispose()
})

test('retry drops stale download frames before notify acknowledgement and retains same-batch new requests', async () => {
 const host = mockHost(), s = host.sessions.A, fw = createFirmwareService(host), c = codec()
 c.parseVersion = () => ({ resultCode: 0, version: 'V1.2.3' }); host.services.set('org.devicedock.sek.firmware.v1', c)
 host.services.set('org.devicedock.firmware.patch.v1', { createPatch: async () => Uint8Array.of(1) }); await fw.addToLibrary('base', raw())
 let attempt = 0
 s.onSend = bytes => {
  if (bytes[0] === 10) s.emit(Uint8Array.of(1))
  if (bytes[0] === 20) { attempt++; if (attempt === 2) { s.emit(Uint8Array.of(3, 255)); s.emit(Uint8Array.of(4, 0)) }; s.emit(Uint8Array.of(2)); s.emit(Uint8Array.of(3, 0)); s.emit(Uint8Array.of(4, attempt === 1 ? 7 : 0)) }
 }
 assert.equal((await fw.upgradeAutomatic('A', raw(), { replyDelayMs: 0 })).executed, true)
 assert.deepEqual(s.writes.filter(b => b[0] === 30).map(b => b[1]), [0, 0]); await fw.dispose()
})
test('service imports a full legacy 20-record library above 8 MB atomically and recomputes metadata', async () => {
 const host = mockHost(), fw = createFirmwareService(host)
 const entries = Array.from({ length: 20 }, (_, i) => { const data = new Uint8Array(450000); data.set(raw()); data[0] = i; return { name: 'fixture-' + i, data: Array.from(data), crc: 0, version: 'untrusted' } })
 const result = await fw.importLibraryJSON({ entries }); assert.equal(result.ids.length, 20); assert.equal(result.evicted.length, 0)
 const rows = await fw.library(); assert.equal(rows.length, 20); assert.ok(rows.every(row => row.version === 'V1.2.3' && row.crc !== 0)); assert.equal(rows.reduce((n, row) => n + row.size, 0), 9000000)
 await assert.rejects(fw.importLibraryJSON([{ name: 'bad', data: [999] }]), /Invalid/); assert.equal((await fw.library()).length, 20); await fw.dispose()
})
