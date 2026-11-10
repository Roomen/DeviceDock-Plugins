// Self-contained Blob worker: main thread supplies verified WASM bytes.
let started = false
self.onmessage = async ({ data }) => {
 if (started) { self.postMessage({ error: 'Worker already used' }); return }; started = true
 let mod, memory
 const pointers = []
 try {
  const old = new Uint8Array(data.old), fresh = new Uint8Array(data.nw)
  if (!old.length || !fresh.length || old.length > 4_000_000 || fresh.length > 4_000_000 || !(data.wasm instanceof ArrayBuffer) || data.wasm.byteLength > 8_000_000) throw Error('Patch input bounds exceeded')
  mod = await createHpatchLiteModule({ instantiateWasm(imports, done) {
   WebAssembly.instantiate(data.wasm, imports).then(result => {
    memory = Object.values(result.instance.exports).find(value => value instanceof WebAssembly.Memory)
    done(result.instance)
   }).catch(error => self.postMessage({ error: error.message }))
  } })
  const alloc = size => { const ptr = mod._malloc(size); if (!ptr) throw Error('Patch allocation failed'); pointers.push(ptr); return ptr }
  const a = alloc(old.length), b = alloc(fresh.length), out = alloc(4)
  new Uint8Array(memory.buffer).set(old, a); new Uint8Array(memory.buffer).set(fresh, b); mod.setValue(out, 0, 'i32')
  const size = mod._hdiffi_create_patch(a, old.length, b, fresh.length, out), ptr = mod.getValue(out, 'i32') >>> 0
  if (ptr) pointers.push(ptr)
  if (size <= 0 || size > 8_000_000 || !ptr || ptr + size > memory.buffer.byteLength) throw Error('Invalid patch output')
  const patch = new Uint8Array(memory.buffer, ptr, size).slice()
  self.postMessage({ patch: patch.buffer }, [patch.buffer])
 } catch (error) { self.postMessage({ error: error.message }) }
 finally { if (mod) for (const ptr of pointers.reverse()) mod._free(ptr) }
}
