import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mockHost, deferred, tick } from './helpers.js'
import { createPowerService } from '../plugins/power/service.js'
import BLU from '../plugins/power/codec.js'
import analysis from '../plugins/power/analysis.js'
import { BlockStore } from '../plugins/power/stream.js'
test('failed voltage write never powers on; queue recovers and state unknown', async () => {
 const host = mockHost(), s = host.sessions.A, power = createPowerService(host)
 s.onSend = async () => { throw Error('write failed') }
 await assert.rejects(power.setPower('A', true, 3300), /write failed/)
 assert.deepEqual([...s.writes[0]], [13, 12, 228]); assert.equal(s.writes.length, 1); assert.equal(power.status().power, null); assert.equal(s.busy, false)
 s.onSend = undefined; await power.setPower('A', false); assert.deepEqual([...s.writes.at(-1)], [12, 0]); await power.dispose()
})
test('queued power ops bind generation before queue; cancellation between voltage and on', async () => {
 const host = mockHost(), power = createPowerService(host), gate = deferred(), s = host.sessions.A
 s.onSend = () => gate.promise
 const first = power.setVoltage('A', 3000), second = power.setPower('A', true, 3300); const rejected = assert.rejects(second, /Connection changed/)
 await tick(); s.generation++; gate.resolve(); await assert.rejects(first, /stale/); await rejected; assert.equal(s.writes.length, 1); await power.dispose()
 const h2 = mockHost(), p2 = createPowerService(h2); h2.sessions.A.onSend = () => h2.controller.abort()
 await assert.rejects(p2.setPower('A', true), /inactive/); assert.equal(h2.sessions.A.writes.length, 1); await p2.dispose()
})
test('capture batches typed samples, claims lane until stopped, cleanup removes listeners', async () => {
 const host = mockHost(), service = createPowerService(host), s = host.sessions.A
 let events = 0; service.subscribe(() => events++)
 await service.start('A'); assert.equal(s.busy, true)
 const before = events
 s.emit(new Uint8Array(4000)); assert.equal(events, before + 1); assert.equal(service.store.samples, 1000); assert.ok(service.store.blocks[0].values instanceof Float32Array)
 await assert.rejects(s.send(Uint8Array.of(1)), /claimed/)
 await service.stop('A'); assert.equal(s.busy, false); assert.equal(s.listeners.size, 0); await service.dispose(); assert.equal(host.resourcesMap.size, 0)
})
test('stop failure keeps acquisition claim until retry; start failure cleans everything', async () => {
 const host = mockHost(), p = createPowerService(host), s = host.sessions.A
 await p.start('A'); s.onSend = async () => { throw Error('failure') }; await assert.rejects(p.stop('A'), /failure/); assert.equal(p.status().sampling, true); assert.equal(s.busy, true)
 s.onSend = null; await p.stop('A'); s.onSend = async () => { throw Error('start failed') }; await assert.rejects(p.start('A'), /start failed/); assert.equal(s.listeners.size, 0); assert.equal(s.busy, false); await p.dispose()
})
test('BLU codec handles arbitrary RX fragmentation and known conversion', () => {
 const parser = new BLU.SampleParser(), input = Uint8Array.of(1, 0, 0, 255)
 assert.equal(parser.push(input.subarray(0, 3)).length, 0); const sample = parser.push(input.subarray(3))[0]
 assert.ok(Math.abs(sample.iUA - 4 * (1.8 / 163840) / 1031.64 * 1e6) < 1e-12); assert.equal(sample.logic, 255)
})
test('offline typed model validates ordering, bounded retention, selection and round trip', () => {
 const store = new BlockStore({ maxSamples: 4 })
 store.append({ times: Float64Array.of(0, 1, 2), values: Float32Array.of(1, 2, 3), rateHz: 1, unit: 'A', gaps: [] })
 store.append({ times: Float64Array.of(3, 4, 5), values: Float32Array.of(4, 5, 6), rateHz: 1, unit: 'A', gaps: [{ missing: 1 }] })
 assert.equal(store.samples, 3); assert.equal(store.evicted, 3); assert.deepEqual([...store.selection(3, 4)], [4, 5])
 const copy = new BlockStore(); copy.import(store.export()); assert.deepEqual(copy.export(), store.export())
 assert.throws(() => copy.append({ times: Float64Array.of(4), values: Float32Array.of(9), rateHz: 1, unit: 'A' }), /unordered/)
})
test('analysis known DC, RMS, charge, battery and FFT sine frequency', () => {
 const stats = analysis.basicStats(Float32Array.of(2, 2, 2, 2)); assert.equal(stats.avg, 2); assert.equal(stats.rms, 2); assert.equal(analysis.chargeFromSum(stats.sum, 0.25), 2)
 assert.equal(analysis.estimateBatteryLife(1000, 1000, { derate: 1 }).hours, 1000)
 const samples = Float64Array.from({ length: 4096 }, (_, i) => Math.sin(2 * Math.PI * 64 * i / 1024) * 10)
 const fft = analysis.fftAnalysis(samples, 1024); assert.equal(fft.ok, true); assert.ok(Math.abs(fft.peaks[0].freqHz - 64) < 0.5)
})
test('disconnect during capture: retain claim through drain, clear on closed notification, reconnect without RX', async () => {
 const host = mockHost(), p = createPowerService(host), s = host.resourcesMap.get('instrument')
 await p.start('instrument'); assert.equal(s.busy, true)
 s.state = 'closing'; s.connected = false; s.generation++; s.emit(new Uint8Array(), 'system')
 assert.equal(p.status().sampling, true); assert.equal(s.busy, true)
 await assert.rejects(p.stop('instrument'), /stale/); assert.equal(s.busy, true)
 s.state = 'cleanup-needed'; s.emit(new Uint8Array(), 'system'); assert.equal(p.status().busy, true); assert.equal(s.busy, true)
 s.state = 'closed'; s.emit(new Uint8Array(), 'system')
 assert.equal(p.status().sampling, false); assert.equal(p.status().busy, false); assert.equal(s.busy, false); assert.equal(s.listeners.size, 0)
 await p.stop('instrument'); await p.connect({}); assert.equal(s.connected, true)
 await p.start('instrument'); await p.stop('instrument'); await p.disconnect(); await p.dispose(); assert.equal(host.resourcesMap.size, 0)
})
test('stale capture can be stopped without notification and releases no claim before physical drain', async () => {
 const host = mockHost(), p = createPowerService(host), s = host.sessions.A
 await p.start('A'); s.generation++; s.state = 'closing'; s.connected = false
 assert.equal(p.status().sampling, true); assert.equal(s.busy, true)
 s.state = 'closed'; await p.stop('A'); assert.equal(p.status().sampling, false); assert.equal(s.busy, false); await p.dispose()
})
test('dispose stop failure preserves acquisition ownership until cleanup retry', async () => {
 const host = mockHost(), p = createPowerService(host), s = host.sessions.A
 await p.start('A'); s.onSend = async () => { throw Error('stop failed') }
 await assert.rejects(p.dispose(), /stop failed/); assert.equal(s.busy, true); assert.equal(s.listeners.size, 1)
 s.onSend = null; await p.dispose(); assert.equal(s.busy, false); assert.equal(s.listeners.size, 0)
})
test('generic analysis integrates declared rates, respects units/gaps and refuses discontinuous FFT', async () => {
 const { analyzeCapture } = await import('../plugins/power/capture-analysis.js'), store = new BlockStore()
 store.append({ times: Float64Array.of(0, 1), values: Float32Array.of(1, 1), rateHz: 1, unit: 'mA', gaps: [] })
 store.append({ times: Float64Array.of(10, 10.5), values: Float32Array.of(2, 2), rateHz: 2, unit: 'mA', gaps: [{ missing: 8 }] })
 const result = analyzeCapture(store); assert.equal(result.integral.value, 4); assert.equal(result.integral.unit, 'mA·s'); assert.equal(result.spectrum.ok, false); assert.equal(result.battery.ok, true)
})
