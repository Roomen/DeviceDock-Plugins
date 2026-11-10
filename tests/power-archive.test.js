import 'fake-indexeddb/auto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CaptureArchive } from '../plugins/power/archive.js'
import { CaptureGate } from '../plugins/power/trigger.js'
import { createPowerService } from '../plugins/power/service.js'
import { mockHost, deferred, tick } from './helpers.js'
const block = (start = 0) => ({ times: Float64Array.of(start, start + 1), values: Float32Array.of(1, 3), unit: 'µA', rateHz: 1, gaps: [] })
test('trigger seeds without false edge, retains bounded pretrigger and stops on opposite edge', () => {
 const gate = new CaptureGate({ start: 'rise', stop: 'fall', level: 5, hysteresis: 1, preSamples: 2 })
 assert.deepEqual(gate.push(9, 0), []); assert.deepEqual(gate.push(0, 1), []); assert.deepEqual(gate.push(1, 2), [])
 assert.deepEqual(gate.push(9, 3), [[0, 1], [1, 2], [9, 3]])
 assert.deepEqual(gate.push(5, 4), [[5, 4]]); assert.equal(gate.phase, 'recording')
 assert.deepEqual(gate.push(0, 5), [[0, 5]]); assert.equal(gate.phase, 'stopped'); assert.deepEqual(gate.push(10, 6), [])
 const duration = new CaptureGate({ durationSeconds: 2 }); duration.push(1, 0); duration.push(1, 2); assert.equal(duration.phase, 'stopped')
 assert.throws(() => new CaptureGate({ preSamples: -1 }), /Invalid/)
})
test('disk journal recovers interrupted sessions, enforces budget atomically and rolls only on request', async () => {
 const name = 'test-power-' + crypto.randomUUID(), archive = new CaptureArchive(name)
 const id = await archive.begin('preserve', { budgetBytes: 1100 })
 await archive.append(id, block()); await archive.append(id, block(2))
 await assert.rejects(archive.append(id, block(4)), /budget full/)
 let rows = await archive.list(); assert.equal(rows[0].next, 2); assert.equal(rows[0].samples, 4); assert.equal(rows[0].state, 'recording')
 archive.close(); const recovered = new CaptureArchive(name), values = []
 for await (const b of recovered.blocks(id)) values.push(...b.values)
 assert.deepEqual(values, [1, 3, 1, 3]); await recovered.finish(id)
 const rolling = await recovered.begin('rolling', { budgetBytes: 1100, rolling: true })
 for (let i = 0; i < 6; i += 2) await recovered.append(rolling, block(i))
 rows = await recovered.list(); const meta = rows.find(r => r.id === rolling)
 assert.equal(meta.samples, 4); assert.equal(meta.evicted, 2); assert.equal(meta.first, 1)
 await recovered.remove(id); await recovered.remove(rolling); assert.deepEqual(await recovered.list(), []); recovered.close()
})
test('durable service retains ownership through disk drain, restart listing/load and CSV', async () => {
 const host = mockHost(), service = createPowerService(host), session = host.sessions.A
 await service.start('A', { durable: true }); session.emit(new Uint8Array(40))
 const id = service.status().archivedId; await service.stop('A'); assert.equal(session.busy, false)
 const saved = await service.captures(); assert.equal(saved.find(r => r.id === id).samples, 10); assert.equal(saved[0].state, 'saved')
 service.store.clear(); await service.loadCapture(id); assert.equal(service.store.samples, 10)
 assert.equal((await (await service.exportCaptureCSV(id)).text()).trim().split('\n').length, 11)
 await service.dispose()
 const again = createPowerService(host); assert.equal((await again.captures()).length, 1); await again.removeCapture(id); await again.dispose()
})
test('durable write failure stops acquisition without execute-like followup or leaked ownership', async () => {
 const host = mockHost(), service = createPowerService(host), session = host.sessions.A
 await service.start('A', { durable: true, budgetBytes: 1024 }); session.emit(new Uint8Array(4000))
 for (let i = 0; i < 50 && service.status().sampling; i++) await tick()
 assert.equal(service.status().sampling, false); assert.match(service.status().archiveError, /budget/); assert.equal(session.busy, false)
 assert.deepEqual([...session.writes.at(-1)], [7]); await service.dispose()
})

test('failed append stops the queued writer at a contiguous prefix', async () => {
 const original = CaptureArchive.prototype.append, gate = deferred(); let calls = 0
 CaptureArchive.prototype.append = async function (...args) { calls++; if (calls === 1) { await gate.promise; throw Error('synthetic disk failure') }; return original.apply(this, args) }
 const host = mockHost(), service = createPowerService(host), session = host.sessions.A
 try {
  await service.start('A', { durable: true }); for (let i = 0; i < 4; i++) session.emit(new Uint8Array(40))
  await tick(); gate.resolve()
  for (let i = 0; i < 100 && service.status().busy; i++) await tick()
  assert.equal(calls, 1); const [saved] = await service.captures(); assert.equal(saved.samples, 0); assert.equal(saved.state, 'error'); assert.equal(session.busy, false)
 } finally { gate.resolve(); CaptureArchive.prototype.append = original; await service.dispose() }
})
test('disconnect journals the terminal state after queued writes; failed STOP retains ownership', async () => {
 const host = mockHost(), service = createPowerService(host), session = host.sessions.A
 await service.start('A', { durable: true }); session.emit(new Uint8Array(40)); session.onSend = () => { throw Error('stop write failure') }
 await assert.rejects(service.stop('A'), /stop write/); assert.equal(session.busy, true); assert.equal(service.status().sampling, true)
 await session.close(); assert.equal(service.status().sampling, false)
 for (let i = 0; i < 100 && service.status().archivePending; i++) await tick()
 const [saved] = await service.captures(); assert.equal(saved.state, 'disconnected'); assert.equal(saved.samples, 10); assert.equal(session.busy, false)
 await service.dispose()
})

test('legacy CSV roundtrip preserves real timestamps, voltage and gaps; invalid import is atomic', async () => {
 const host = mockHost(), service = createPowerService(host)
 service.importCSV('timestamp_s,current_uA,voltage_mV\n0,10,3300\n0.001,20,3300\n1,30,3200\n1.001,40,3200')
 assert.equal(service.store.samples, 4); assert.equal(service.store.blocks[1].voltageMv, 3200); assert.equal(service.analyze().spectrum.ok, false)
 const exported = await (await service.exportCaptureCSV(null, { offset: 3, limit: 1 })).text(); assert.match(exported, /1.001,40,µA,[^,]+,1,3200/)
 const full = await (await service.exportCaptureCSV()).text(); service.importCSV(full); assert.equal(service.store.samples, 4)
 assert.throws(() => service.importCSV('0,1\n0,2'), /unordered/); assert.equal(service.store.samples, 4)
 await assert.rejects(service.loadCapture('missing'), /not found/); await service.dispose()
})
test('constant-memory long statistics count all samples and raw capture preserves pre-parser bytes', async () => {
 const host = mockHost(), service = createPowerService(host), session = host.sessions.A
 service.captureRaw(4096); await service.setVoltage('A', 3300); await service.start('A', { mode: 'long' })
 for (let i = 0; i < 10; i++) session.emit(new Uint8Array(40))
 await service.stop('A'); assert.equal(service.store.samples, 0); assert.equal(service.summary().totalSamples, 100); assert.equal(service.summary().span, 'all'); assert.equal(service.dumpRaw().length, 400)
 assert.equal(service.streamStats().capturedBytes, 400); await service.dispose()
})
test('auto trigger learns pre-range; warmup seeds without consuming the next edge', () => {
 const gate = new CaptureGate({ start: 'rise', stop: 'fall', autoLevel: true, warmupSamples: 3 })
 assert.deepEqual(gate.push(10, 0), []); assert.deepEqual(gate.push(0, 1), []); assert.deepEqual(gate.push(10, 2), []); assert.equal(gate.phase, 'armed')
 assert.deepEqual(gate.push(0, 3), []); assert.deepEqual(gate.push(10, 4), [[10, 4]]); assert.equal(gate.phase, 'recording')
 assert.deepEqual(gate.push(0, 5), [[0, 5]]); assert.equal(gate.phase, 'stopped')
})
test('power probe uses a separate parser and retains an existing waveform', async () => {
 const host = mockHost(), service = createPowerService(host), session = host.sessions.A
 service.store.append(block()); session.onSend = bytes => { if (bytes[0] === 6) session.emit(new Uint8Array(1000)) }
 const result = await service.probePower('A'); assert.equal(result.samples, 250); assert.equal(typeof result.on, 'boolean'); assert.equal(service.store.samples, 2); assert.equal(session.busy, false); assert.deepEqual([...session.writes.at(-1)], [7]); await service.dispose()
})
test('legacy event anchor mapping handles clock jumps, pruning and noncaptured intervals', async () => {
 const { createAnchorTrack, mergeMarks } = await import('../plugins/power/serial-events.js')
 let offset = 1000; const track = createAnchorTrack({ intervalMs: 1, gapMs: 1000, wallOffset: () => offset })
 for (let i = 0; i < 100; i++) { if (i === 50) offset = 5000; track.note(i, i * 10) }
 assert.equal(track.segmentCount(), 2); assert.equal(track.perfToLi(505), 50.5); assert.equal(track.wallToLi(5505), 50.5)
 track.pruneBefore(80); assert.ok(track.anchorCount() <= 21); assert.equal(track.perfToLi(805), 80.5); assert.equal(track.perfToLi(0), null)
 assert.equal(mergeMarks([1, 2, 3], 4, 48)[0].n, 3); track.reset(); assert.equal(track.has(), false)
})
