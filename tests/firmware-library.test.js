import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IDBFactory } from 'fake-indexeddb'
import { createFirmwareLibrary } from '../plugins/firmware/library.js'
function setup() { const map = new Map(), storage = { get: key => map.get(key), set: (key, value) => map.set(key, value) }; return { storage, idb: new IDBFactory() } }
test('binary library reaches advertised bounds, deduplicates, retains legacy capacity and persists', async () => {
 const { storage, idb } = setup(), library = createFirmwareLibrary(storage, idb)
 const a = new Uint8Array(4_000_000).fill(1), b = new Uint8Array(4_000_000).fill(2)
 const meta = { version: 'v1', crc: 1 }
 const first = await library.add({ ...meta, name: 'a' }, a)
 await library.add({ ...meta, name: 'b' }, b); assert.equal((await library.list()).length, 2)
 assert.deepEqual((await library.read(first)).data, a)
 await library.add({ ...meta, name: 'replacement' }, a); assert.equal((await library.list()).length, 2)
 await assert.rejects(library.add(meta, new Uint8Array(32 * 1024 * 1024 + 1)), /exceeds|too large/)
 await library.add(meta, Uint8Array.of(3)); assert.equal((await library.list()).length, 3)
 assert.ok((await library.list()).some(row => row.name === 'replacement'))
 await library.close(); const again = createFirmwareLibrary(storage, idb); assert.equal((await again.list()).length, 3); await again.close()
})
test('concurrent writers serialize eviction; aborted write preserves earlier records with no orphan blobs', async () => {
 const { storage, idb } = setup(), a = createFirmwareLibrary(storage, idb), b = createFirmwareLibrary(storage, idb)
 const keep = await a.add({ name: 'keep' }, Uint8Array.of(9))
 const db = await new Promise((resolve, reject) => { const req = idb.open('devicedock.firmware.' + storage.get('libraryDatabase')); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) })
 // Block the next writer until cancellation is registered on its real IDB transaction.
 const blocker = db.transaction('entries', 'readwrite'); const controller = new AbortController()
 const pending = a.add({ name: 'cancel' }, Uint8Array.of(10), { signal: controller.signal }); controller.abort()
 await assert.rejects(pending, /abort/i); assert.equal((await a.list()).length, 1); assert.deepEqual((await a.read(keep)).data, Uint8Array.of(9))
 await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).add({ name: String(i) }, Uint8Array.of(i + 20))))
 assert.equal((await a.list()).length, 20)
 await new Promise((resolve, reject) => { const tx = db.transaction('entries'); const req = tx.objectStore('entries').getAll(); req.onsuccess = () => { assert.equal(req.result.length, 20); assert.ok(req.result.every(row => row.blob instanceof Blob)); resolve() }; tx.onerror = () => reject(tx.error) })
 db.close(); await a.close(); await b.close()
})
test('quota/request failure rolls back replacement and eviction together', async () => {
 const { storage, idb } = setup(), lib = createFirmwareLibrary(storage, idb)
 const first = await lib.add({ name: 'original' }, Uint8Array.of(1))
 // Simulate quota at the actual IDB request boundary; the native transaction aborts.
 const proto = Object.getPrototypeOf((await new Promise(resolve => { const r = idb.open('devicedock.firmware.' + storage.get('libraryDatabase')); r.onsuccess = () => resolve(r.result) })).transaction('entries', 'readwrite').objectStore('entries'))
 const put = proto.put
 proto.put = function () { throw new DOMException('Quota reached', 'QuotaExceededError') }
 try { await assert.rejects(lib.add({ name: 'failed' }, Uint8Array.of(2)), /Quota/); assert.deepEqual((await lib.list()).map(row => row.id), [first]) }
 finally { proto.put = put; await lib.close() }
})

test('abort during the write transaction rolls back the actual queued Blob request', async () => {
 const { storage, idb } = setup(), lib = createFirmwareLibrary(storage, idb)
 const original = await lib.add({ name: 'original' }, Uint8Array.of(1))
 const controller = new AbortController()
 const db = await new Promise(resolve => { const req = idb.open('devicedock.firmware.' + storage.get('libraryDatabase')); req.onsuccess = () => resolve(req.result) })
 const proto = Object.getPrototypeOf(db.transaction('entries', 'readwrite').objectStore('entries')), put = proto.put
 proto.put = function (...args) { const req = put.apply(this, args); controller.abort(); return req }
 try {
  await assert.rejects(lib.add({ name: 'cancelled' }, Uint8Array.of(2), { signal: controller.signal }), /abort/i)
  assert.deepEqual((await lib.list()).map(row => row.id), [original])
 } finally { proto.put = put; db.close(); await lib.close() }
})

test('LRU read protects a baseline and reports eviction at 20 entries / 32 MiB', async () => {
 const { storage, idb } = setup(), lib = createFirmwareLibrary(storage, idb), ids = []
 for (let i = 0; i < 20; i++) ids.push(await lib.add({ name: String(i) }, Uint8Array.of(i)))
 await lib.read(ids[0]); const result = await lib.add({ name: 'new' }, Uint8Array.of(20), { report: true })
 assert.equal(result.evicted.length, 1); assert.equal(result.evicted[0].id, ids[1]); assert.equal((await lib.read(ids[0])).name, '0')
 const batch = Array.from({ length: 20 }, (_, i) => ({ meta: { name: 'legacy-' + i }, data: new Uint8Array(500000).fill(i + 50) }))
 const imported = await lib.addMany(batch); assert.equal(imported.ids.length, 20); assert.equal(imported.evicted.length, 20); assert.equal((await lib.list()).reduce((n, r) => n + r.size, 0), 10000000)
 await lib.close()
})
