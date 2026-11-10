// Optional read-only local compatibility input. Never packaged; no private firmware.
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
export async function legacyEngine(directory) {
 const require = createRequire(import.meta.url), create = require(resolve(directory, 'hdiffi.js')), bytes = await readFile(resolve(directory, 'hdiffi.wasm')); let memory
 const mod = await create({ instantiateWasm(imports, done) { WebAssembly.instantiate(bytes, imports).then(result => { memory = Object.values(result.instance.exports).find(value => value instanceof WebAssembly.Memory); done(result.instance) }) } })
 return (old, fresh) => {
  const pointers = []
  try {
   const alloc = size => { const ptr = mod._malloc(size); if (!ptr) throw Error('Legacy allocation failed'); pointers.push(ptr); return ptr }
   const a = alloc(old.length), b = alloc(fresh.length), out = alloc(4)
   new Uint8Array(memory.buffer).set(old, a); new Uint8Array(memory.buffer).set(fresh, b); mod.setValue(out, 0, 'i32')
   const size = mod._hdiffi_create_patch(a, old.length, b, fresh.length, out), ptr = mod.getValue(out, 'i32') >>> 0; if (ptr) pointers.push(ptr)
   if (!ptr || size <= 0 || size > 8_000_000) throw Error('Legacy patch failed')
   return new Uint8Array(memory.buffer, ptr, size).slice()
  } finally { pointers.forEach(ptr => mod._free(ptr)) }
 }
}
