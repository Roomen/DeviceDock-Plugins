import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBleDriver } from '../plugins/wireless/ble.js'
import { createStreamPort } from '../plugins/shared/stream-port.js'
import { deferred, tick } from './helpers.js'
function device() {
 const target = new EventTarget(), rx = new EventTarget(), chunks = []
 Object.assign(rx, { properties: { writeWithoutResponse: true }, startNotifications: async () => {}, stopNotifications: async () => {}, writeValueWithoutResponse: async bytes => { chunks.push([...bytes]) } })
 let disconnects = 0
 const server = { getPrimaryService: async () => ({ getCharacteristic: async () => rx }), disconnect() { disconnects++; target.dispatchEvent(new Event('gattserverdisconnected')) } }
 Object.assign(target, { name: 'Synthetic', gatt: { connect: async () => server } })
 return { target, rx, chunks, server, get disconnects() { return disconnects } }
}
test('BLE writes serialized in 20-byte chunks and RX owns copied DataView offsets', async () => {
 const d = device(), driver = createBleDriver(d.target), received = []
 await driver.open({}, { data: b => received.push(b), lost() {} })
 await Promise.all([driver.write(Uint8Array.from({ length: 45 }, (_, i) => i)), driver.write(Uint8Array.of(99))])
 assert.deepEqual(d.chunks.map(c => c.length), [20, 20, 5, 1])
 const buffer = Uint8Array.of(88, 1, 2, 99); d.rx.value = new DataView(buffer.buffer, 1, 2); d.rx.dispatchEvent(new Event('characteristicvaluechanged')); buffer[1] = 8; assert.deepEqual([...received[0]], [1, 2]); await driver.close()
})
test('close during delayed BLE connect waits and cleans up late-open server', async () => {
 const d = device(), gate = deferred(), driver = createBleDriver(d.target); d.target.gatt.connect = () => gate.promise
 const opening = driver.open({}, { data() {}, lost() {} }), rejected = assert.rejects(opening, /cancelled/)
 let closed = false; const closing = driver.close().then(() => { closed = true }); await tick(); assert.equal(closed, false); gate.resolve(d.server); await rejected; await closing; assert.equal(d.disconnects, 1)
})
test('disconnect stops remaining queued BLE chunks and stale notifications', async () => {
 const d = device(), driver = createBleDriver(d.target); let lost = 0, received = 0
 await driver.open({}, { data() { received++ }, lost() { lost++ } })
 d.rx.writeValueWithoutResponse = async bytes => { d.chunks.push([...bytes]); d.target.dispatchEvent(new Event('gattserverdisconnected')) }
 await assert.rejects(driver.write(new Uint8Array(45)), /disconnected/); assert.equal(d.chunks.length, 1); assert.equal(lost, 1)
 d.rx.value = new DataView(new Uint8Array(2).buffer); d.rx.dispatchEvent(new Event('characteristicvaluechanged')); assert.equal(received, 0); await driver.close()
})
test('stream port retains cleanup-needed state after close failure and retries', async () => {
 let fail = true, closes = 0
 const port = createStreamPort({ async open() {}, async write() {}, async close() { closes++; if (fail) throw Error('close failed') } })
 await port.open({}); await assert.rejects(port.close(), /close failed/); assert.equal(port.state, 'cleanup-needed')
 fail = false; await port.close(); assert.equal(port.state, 'closed'); assert.equal(closes, 2)
})
test('BLE unplug releases dead notification state and permits reopen', async () => {
 const d = device(), port = createStreamPort(createBleDriver(d.target))
 d.target.gatt.connected = true
 await port.open({}); const reader = port.readable.getReader(); const failed = assert.rejects(reader.read(), /disconnected/)
 d.target.gatt.connected = false
 d.rx.stopNotifications = async () => { throw Error('GATT disconnected') }
 d.target.dispatchEvent(new Event('gattserverdisconnected')); await failed; reader.releaseLock()
 await port.close(); assert.equal(port.state, 'closed')
 d.target.gatt.connected = true; d.rx.stopNotifications = async () => {}
 await port.open({}); await port.close(); assert.equal(port.state, 'closed')
})
test('recoverable sink failure replaces writable, keeps ordering and drains actual writes', async () => {
 const gate = deferred(), calls = []; let fail = true
 const port = createStreamPort({ async open() {}, async write(bytes) { calls.push(bytes[0]); if (fail) { fail = false; throw Error('write failed') }; await gate.promise }, async close() { calls.push('closed') } })
 await port.open({}); const firstStream = port.writable, first = firstStream.getWriter()
 await assert.rejects(first.write(Uint8Array.of(1)), /write failed/); first.releaseLock()
 assert.notEqual(port.writable, firstStream); const second = port.writable.getWriter()
 const write = second.write(Uint8Array.of(2)); await tick()
 const close = port.close(); await tick(); assert.deepEqual(calls, [1, 2]); gate.resolve(); await assert.rejects(write, /lost/); second.releaseLock(); await close
 assert.deepEqual(calls, [1, 2, 'closed']); assert.equal(port.state, 'closed')
})
test('BLE failed notification cleanup retains native ownership until successful retry', async () => {
 const d = device(), driver = createBleDriver(d.target), gate = deferred(); let fail = true
 d.target.gatt.connected = true
 await driver.open({}, { data() {}, lost() {} })
 d.rx.stopNotifications = async () => { await gate.promise; if (fail) throw Error('stop failed') }
 const closing = driver.close(), rejected = assert.rejects(closing, /stop failed/)
 await tick(); await assert.rejects(driver.open({}, { data() {}, lost() {} }), /cleanup required/)
 gate.resolve(); await rejected; fail = false; await driver.close()
 await driver.open({}, { data() {}, lost() {} }); await driver.close()
})
