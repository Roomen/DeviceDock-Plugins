// Generic timestamped typed blocks; independent of transport, BLU and DOM.
export function validateBlock(block) {
 const { values, times, rateHz, unit } = block
 if (!(values instanceof Float32Array || values instanceof Float64Array) || !(times instanceof Float64Array) || values.length !== times.length || !unit || !Number.isFinite(rateHz) || rateHz <= 0) throw Error('Invalid sample block')
 for (let i = 0; i < times.length; i++) if (!Number.isFinite(times[i]) || (i && times[i] <= times[i - 1])) throw Error('Timestamps must increase')
 return block
}
export class BlockStore {
 constructor({ maxSamples = 2_000_000 } = {}) { this.blocks = []; this.samples = 0; this.maxSamples = maxSamples; this.evicted = 0 }
 append(block) {
  validateBlock(block)
  const last = this.blocks.at(-1)
  if (last && (last.unit !== block.unit || block.times[0] <= last.times.at(-1))) throw Error('Incompatible or unordered block')
  if (!block.values.length) return
  const copy = { ...block, values: block.values.slice(), times: block.times.slice(), gaps: structuredClone(block.gaps || []) }
  if (copy.values.length > this.maxSamples) { const drop = copy.values.length - this.maxSamples; this.evicted += drop; copy.values = copy.values.slice(drop); copy.times = copy.times.slice(drop) }
  this.blocks.push(copy); this.samples += copy.values.length
  while (this.samples > this.maxSamples && this.blocks.length > 1) { const n = this.blocks.shift().values.length; this.samples -= n; this.evicted += n }
 }
 clear() { this.blocks = []; this.samples = 0; this.evicted = 0 }
 series(from = -Infinity, to = Infinity) {
  const values = [], times = [], breaks = []; let previous
  for (const b of this.blocks) for (let i = 0; i < b.values.length; i++) {
   const time = b.times[i]; if (time < from || time > to) continue
   if (previous != null && (Math.abs(time - previous - 1 / b.rateHz) > .1 / b.rateHz || i === 0 && b.gaps?.length)) breaks.push(values.length)
   values.push(b.values[i]); times.push(time); previous = time
  }
  return { values, times, breaks }
 }
 selection(from = -Infinity, to = Infinity) {
  const out = []
  for (const b of this.blocks) for (let i = 0; i < b.values.length; i++) if (b.times[i] >= from && b.times[i] <= to) out.push(b.values[i])
  return Float64Array.from(out)
 }
 export() { return { schemaVersion: 1, evicted: this.evicted, blocks: this.blocks.map(b => ({ ...b, times: Array.from(b.times), values: Array.from(b.values) })) } }
 import(data) {
  if (data.schemaVersion !== 1 || !Array.isArray(data.blocks)) throw Error('Unknown capture schema')
  const next = new BlockStore({ maxSamples: this.maxSamples })
  for (const b of data.blocks) next.append({ ...b, times: Float64Array.from(b.times), values: Float64Array.from(b.values) })
  this.blocks = next.blocks; this.samples = next.samples; this.evicted = next.evicted + (data.evicted || 0)
 }
}
// Optional block persistence: one transaction per batch, never per sample.
export class IndexedBlocks {
 constructor(name = 'devicedock-power-v1') { this.name = name; this.db = null }
 async open() {
  this.db = await new Promise((resolve, reject) => { const req = indexedDB.open(this.name, 1); req.onupgradeneeded = () => req.result.createObjectStore('blocks'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) })
 }
 async put(capture, index, block) { validateBlock(block); return this.operation('readwrite', s => s.put(block, [capture, index])) }
 async remove(capture, count) { for (let i = 0; i < count; i++) await this.operation('readwrite', s => s.delete([capture, i])) }
 async get(capture, index) { return this.operation('readonly', s => s.get([capture, index])) }
 operation(mode, fn) { return new Promise((resolve, reject) => { if (!this.db) return reject(Error('Storage closed')); const tx = this.db.transaction('blocks', mode); const req = fn(tx.objectStore('blocks')); tx.oncomplete = () => resolve(req.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || Error('Storage aborted')) }) }
 close() { this.db?.close(); this.db = null }
}
