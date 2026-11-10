import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPatchService } from '../plugins/patch/service.js'
import { deferred, tick } from './helpers.js'
function setup() {
 const controller = new AbortController(), workers = []
 return { workers, host: { signal: controller.signal, assets: {
  read: async path => { assert.equal(path, 'patch/hdiffi.wasm'); return Uint8Array.of(0) },
  createWorker: async path => { assert.equal(path, 'patch/worker.js'); const worker = { terminated: false, postMessage(data) { this.data = data }, terminate() { this.terminated = true } }; workers.push(worker); return worker },
 } } }
}
test('patch provider preserves inputs and terminates on success, error, cancellation and timeout', async () => {
 const { host, workers } = setup(), api = createPatchService(host), old = Uint8Array.of(1), nw = Uint8Array.of(2)
 const success = api.createPatch(old, nw); await tick(); workers[0].onmessage({ data: { patch: Uint8Array.of(3).buffer } }); assert.deepEqual(await success, Uint8Array.of(3)); assert.ok(workers[0].terminated); assert.deepEqual(old, Uint8Array.of(1))
 const failed = api.createPatch(old, nw), rejection = assert.rejects(failed, /engine failed/); await tick(); workers[1].onmessage({ data: { error: 'engine failed' } }); await rejection; assert.ok(workers[1].terminated)
 const controller = new AbortController(), cancelled = api.createPatch(old, nw, { signal: controller.signal }), cancelledCheck = assert.rejects(cancelled, /cancelled/)
 await tick(); controller.abort(); await cancelledCheck; assert.ok(workers[2].terminated)
 await assert.rejects(api.createPatch(old, nw, { timeoutMs: 5 }), /timeout/); assert.ok(workers[3].terminated)
 await assert.rejects(api.createPatch(new Uint8Array(4_000_001), nw), /input/); assert.equal(workers.length, 4); api.dispose()
})
test('cancelled late worker creation retains busy ownership until creation settles, then terminates', async () => {
 const { host } = setup(), gate = deferred(), controller = new AbortController(); let terminated = false
 host.assets.createWorker = () => gate.promise
 const api = createPatchService(host), pending = api.createPatch(Uint8Array.of(1), Uint8Array.of(2), { signal: controller.signal })
 const rejected = assert.rejects(pending, /abort/i); await tick(); controller.abort(); assert.equal(api.busy, true); assert.throws(() => api.dispose(), /Wait/)
 gate.resolve({ terminate() { terminated = true } }); await rejected; assert.equal(terminated, true); assert.equal(api.busy, false); api.dispose()
})
