export function createPatchService(host) {
 let active = null, disposed = false
 const api = {
  apiVersion: 1, engine: 'HPatchLite v0.4.3 / source-built tinyuz-1024 WASM',
  get busy() { return !!active },
  async createPatch(oldBytes, newBytes, { signal, timeoutMs = 300000 } = {}) {
   if (disposed || host.signal.aborted || active) throw Error('Patch provider busy or inactive')
   if (!(oldBytes instanceof Uint8Array) || !(newBytes instanceof Uint8Array) || !oldBytes.length || !newBytes.length || oldBytes.length > 4_000_000 || newBytes.length > 4_000_000) throw Error('Patch input must be 1–4000000 bytes')
   if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw Error('Invalid patch timeout')
   if (!host.assets?.read || !host.assets?.createWorker) throw Error('Host verified worker assets API required')
   const controller = new AbortController(), cancel = () => controller.abort()
   active = controller; signal?.addEventListener('abort', cancel, { once: true }); host.signal.addEventListener('abort', cancel, { once: true })
   if (signal?.aborted) cancel()
   let worker, timer
   try {
    controller.signal.throwIfAborted()
    const wasm = (await host.assets.read('patch/hdiffi.wasm')).slice()
    controller.signal.throwIfAborted()
    worker = await host.assets.createWorker('patch/worker.js')
    controller.signal.throwIfAborted()
    return await new Promise((resolve, reject) => {
     const abort = () => reject(Error('Patch task cancelled'))
     controller.signal.addEventListener('abort', abort, { once: true })
     active.removeAbort = () => controller.signal.removeEventListener('abort', abort)
     timer = setTimeout(() => reject(Error('Patch task timeout')), timeoutMs)
     worker.onerror = () => reject(Error('Patch worker failed'))
     worker.onmessageerror = () => reject(Error('Patch worker message failed'))
     worker.onmessage = ({ data }) => {
      if (data.error) return reject(Error(data.error))
      if (!(data.patch instanceof ArrayBuffer) || !data.patch.byteLength || data.patch.byteLength > 8_000_000) return reject(Error('Invalid patch output'))
      resolve(new Uint8Array(data.patch))
     }
     const old = oldBytes.slice(), nw = newBytes.slice()
     worker.postMessage({ wasm: wasm.buffer, old: old.buffer, nw: nw.buffer }, [wasm.buffer, old.buffer, nw.buffer])
    })
   } finally {
    clearTimeout(timer); worker?.terminate(); active?.removeAbort?.(); active = null
    signal?.removeEventListener('abort', cancel); host.signal.removeEventListener('abort', cancel)
   }
  },
  dispose() { if (active) throw Error('Wait for patch task before disabling'); disposed = true },
 }
 return api
}
