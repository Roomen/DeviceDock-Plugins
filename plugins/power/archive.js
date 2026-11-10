import { validateBlock } from './stream.js'
// Source-scoped, crash-readable block journal. Metadata and each block commit together.
export class CaptureArchive {
 constructor(name, indexedDB = globalThis.indexedDB) { this.name = name; this.indexedDB = indexedDB; this.db = null }
 async open() {
  if (this.db) return
  if (!this.indexedDB) throw Error('IndexedDB unavailable')
  this.db = await new Promise((resolve, reject) => {
   const req = this.indexedDB.open(this.name, 1)
   req.onupgradeneeded = () => { req.result.createObjectStore('captures', { keyPath: 'id' }); req.result.createObjectStore('blocks') }
   req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error)
  })
 }
 async tx(mode, action) {
  await this.open()
  return new Promise((resolve, reject) => {
   const tx = this.db.transaction(['captures', 'blocks'], mode); let result, failure
   tx.oncomplete = () => resolve(result)
   tx.onabort = () => reject(failure || tx.error || Error('Capture transaction aborted'))
   const fail = e => { failure = e; tx.abort() }
   try { action(tx.objectStore('captures'), tx.objectStore('blocks'), v => { result = v }, fail) } catch (e) { fail(e) }
  })
 }
 begin(name, { budgetBytes = 128_000_000, rolling = false } = {}) {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1024 || budgetBytes > 2_000_000_000) return Promise.reject(Error('Disk budget must be 1 KB–2 GB'))
  const meta = { id: crypto.randomUUID(), name: String(name).slice(0, 80), created: Date.now(), first: 0, next: 0, bytes: 0, samples: 0, evicted: 0, budgetBytes, rolling, state: 'recording' }
  return this.tx('readwrite', (m, b, done) => { m.put(meta); done(meta.id) })
 }
 append(id, block) {
  validateBlock(block)
  const copy = { ...block, values: block.values.slice(), times: block.times.slice(), gaps: structuredClone(block.gaps || []) }
  // Include a conservative allowance for keys/metadata; bounded record count as well as sample bytes.
  const bytes = copy.values.byteLength + copy.times.byteLength + JSON.stringify(copy.gaps).length * 2 + 512
  return this.tx('readwrite', (m, b, done, fail) => {
   const req = m.get(id); req.onsuccess = () => {
    const meta = req.result
    if (!meta || meta.state !== 'recording') return fail(Error('Capture archive is not recording'))
    if (bytes > meta.budgetBytes) return fail(Error('Capture block exceeds disk budget'))
    const write = () => {
     if (meta.bytes + bytes > meta.budgetBytes || meta.next - meta.first >= 20000) {
      if (!meta.rolling) return fail(Error('Capture disk budget full'))
      const old = b.get([id, meta.first]); old.onsuccess = () => { if (!old.result) return fail(Error('Missing archived block')); meta.bytes -= old.result.bytes; meta.samples -= old.result.block.values.length; meta.evicted += old.result.block.values.length; b.delete([id, meta.first++]); write() }; return
     }
     b.put({ bytes, block: copy }, [id, meta.next++]); meta.bytes += bytes; meta.samples += copy.values.length; m.put(meta); done(meta)
    }
    write()
   }
  })
 }
 finish(id, state = 'saved') { return this.tx('readwrite', (m, b, done) => { const r = m.get(id); r.onsuccess = () => { if (r.result) m.put({ ...r.result, state }); done() } }) }
 list() { return this.tx('readonly', (m, b, done) => { const r = m.getAll(); r.onsuccess = () => done(r.result.sort((a, b) => b.created - a.created)) }) }
 async *blocks(id) {
  const meta = (await this.list()).find(row => row.id === id)
  if (!meta) throw Error('Capture not found')
  // Per-block reads keep large exports off the retained RAM preview.
  for (let i = meta.first; i < meta.next; i++) {
   const row = await this.tx('readonly', (m, b, done) => { const r = b.get([id, i]); r.onsuccess = () => done(r.result) })
   if (!row) throw Error('Archived block missing or capture changed')
   yield row.block
  }
 }
 remove(id) { return this.tx('readwrite', (m, b) => { const r = m.get(id); r.onsuccess = () => { if (!r.result) return; for (let i = r.result.first; i < r.result.next; i++) b.delete([id, i]); m.delete(id) } }) }
 close() { this.db?.close(); this.db = null }
}
