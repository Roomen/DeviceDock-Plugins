// Blob and metadata share one record and one transaction: no orphan binary store.
export function createFirmwareLibrary(storage, indexedDB = globalThis.indexedDB) {
 let dbPromise, closed = false
 let identity = storage.get('libraryDatabase')
 if (!identity) { identity = crypto.randomUUID(); storage.set('libraryDatabase', identity) }
 function open() {
  if (closed) throw Error('Firmware library closed')
  if (!indexedDB) throw Error('IndexedDB unavailable; firmware library requires binary storage')
  return dbPromise ||= new Promise((resolve, reject) => {
   const req = indexedDB.open('devicedock.firmware.' + identity, 1)
   req.onupgradeneeded = () => req.result.createObjectStore('entries', { keyPath: 'id' })
   req.onsuccess = () => { const db = req.result; db.onversionchange = () => db.close(); resolve(db) }
   req.onerror = () => { dbPromise = null; reject(req.error) }
   req.onblocked = () => { /* Existing connections must finish before the upgrade. */ }
  })
 }
 async function transaction(mode, action, signal) {
  signal?.throwIfAborted(); const db = await open(); signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
   const tx = db.transaction('entries', mode), store = tx.objectStore('entries'); let value, failure
   const cancel = () => { try { tx.abort() } catch {} }
   signal?.addEventListener('abort', cancel, { once: true })
   const cleanup = () => signal?.removeEventListener('abort', cancel)
   tx.oncomplete = () => { cleanup(); resolve(value) }
   // Resolve/reject only after commit/rollback has actually completed.
   tx.onabort = () => { cleanup(); reject(failure || tx.error || Error('Firmware library transaction aborted')) }
   try { action(store, result => { value = result }, error => { failure = error; cancel() }) } catch (e) { failure = e; cancel() }
  })
 }
 return {
  async list({ signal } = {}) {
   const rows = await transaction('readonly', (store, done) => { const req = store.getAll(); req.onsuccess = () => done(req.result) }, signal)
   return rows.sort((a, b) => a.order - b.order).map(({ blob, ...meta }) => meta)
  },
  async read(id, { signal } = {}) {
   const row = await transaction('readwrite', (store, done) => { const req = store.getAll(); req.onsuccess = () => { const row = req.result.find(row => row.id === id); if (row) { row.usedAt = Math.max(Date.now(), ...req.result.map(r => (r.usedAt || 0) + 1)); store.put(row) }; done(row) } }, signal)
   if (!row) throw Error('Firmware library entry no longer exists')
   const data = new Uint8Array(await row.blob.arrayBuffer()); signal?.throwIfAborted(); return { ...row, blob: undefined, data }
  },
  async add(meta, bytes, options = {}) { const result = await this.addMany([{ meta, data: bytes }], options); return options.report ? { id: result.ids[0], evicted: result.evicted } : result.ids[0] },
  async addMany(entries, { signal } = {}) {
   if (!Array.isArray(entries) || entries.length > 20 || entries.reduce((n, row) => n + row.data.length, 0) > 32 * 1024 * 1024) throw Error('Firmware import exceeds 20 entries / 32 MiB')
   const prepared = []
   for (const { meta, data } of entries) {
    signal?.throwIfAborted()
    if (data.length > 32 * 1024 * 1024) throw Error('Firmware library entry too large')
    const copy = data.slice(), digest = await crypto.subtle.digest('SHA-256', copy)
    const id = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
    prepared.push({ ...meta, id, size: copy.length, blob: new Blob([copy]) })
   }
   return transaction('readwrite', (store, done, fail) => {
    const req = store.getAll(); req.onsuccess = () => {
     try {
      const keep = new Set(prepared.map(row => row.id)), old = req.result.filter(row => !keep.has(row.id)).sort((a, b) => (a.usedAt || a.order || 0) - (b.usedAt || b.order || 0) || a.order - b.order)
      const fresh = [...new Map(prepared.map(row => [row.id, row])).values()]
      let order = Math.max(0, ...req.result.map(row => row.order)), total = [...old, ...fresh].reduce((n, row) => n + row.size, 0), evicted = []
      while (total > 32 * 1024 * 1024 || old.length + fresh.length > 20) { const row = old.shift(); if (!row) throw Error('Import exceeds firmware library budget'); total -= row.size; evicted.push({ id: row.id, name: row.name, size: row.size }); store.delete(row.id) }
      let usedAt = Math.max(Date.now(), ...req.result.map(r => (r.usedAt || 0) + 1)); for (const row of fresh) store.put({ ...row, order: ++order, usedAt: usedAt++ })
      done({ ids: prepared.map(row => row.id), evicted })
     } catch (e) { fail(e) }
    }
   }, signal)
  },
  remove(id, { signal } = {}) { return transaction('readwrite', (store, done) => { store.delete(id); done() }, signal) },
  async close() { closed = true; if (dbPromise) (await dbPromise).close() },
 }
}
