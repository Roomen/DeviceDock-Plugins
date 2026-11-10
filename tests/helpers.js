export const tick = () => new Promise(resolve => setTimeout(resolve, 0))
export function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
export function mockSession() {
 const listeners = new Set(), writes = []
 let owner, claims = 0
 const session = {
  generation: 1, state: 'open', connected: true, writes, listeners,
  async open() { this.generation++; this.connected = true; this.state = 'open' },
  async close() { this.generation++; this.connected = false; this.state = 'closed' },
  async setSignals(signals, options = {}) { await options.beforeWrite?.(); this.signals = { ...signals } },
  get busy() { return claims > 0 },
  claim(who) { if (owner && owner !== who) throw Error('claimed'); owner = who; claims++; let live = true; return () => { if (live) { live = false; if (!--claims) owner = null } } },
  async send(bytes, options = {}) { if (!this.connected || options.generation != null && options.generation !== this.generation) throw Error('stale'); if (owner && owner !== options.owner) throw Error('claimed'); await options.beforeWrite?.(); if (!this.connected || options.generation != null && options.generation !== this.generation) throw Error('stale'); writes.push(bytes.slice()); await this.onSend?.(bytes); if (options.generation != null && options.generation !== this.generation) throw Error('stale') },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
  emit(bytes, direction = 'rx') { for (const fn of [...listeners]) fn({ direction, bytes, generation: this.generation }) },
  async transaction(who, run, { signal } = {}) {
   const release = this.claim(who), controller = new AbortController(), generation = this.generation
   const abort = () => controller.abort(); signal?.addEventListener('abort', abort); if (signal?.aborted) abort()
   try { return await run({ signal: controller.signal, send: (bytes, sendOptions = {}) => { if (controller.signal.aborted) throw Error('cancelled'); return this.send(bytes, { owner: who, generation, beforeWrite: sendOptions.beforeWrite }) }, subscribe: fn => this.subscribe(fn) }) }
   finally { controller.abort(); signal?.removeEventListener('abort', abort); release() }
  },
 }
 return session
}
export function mockHost() {
 const controller = new AbortController(), sessions = { A: mockSession(), B: mockSession() }, services = new Map(), data = new Map(), resources = new Map()
 return { apiVersion: 1, capabilities: {}, signal: controller.signal, controller, services, sessions, resourcesMap: resources,
  session: lane => sessions[lane], getService: key => services.get(key),
  registerService(key, value) { services.set(key, value); return () => services.delete(key) },
  registerTransport() { return () => {} },
  prepareDeactivate() { return () => {} },
  resources: { createSession(id) { if (resources.has(id)) throw Error('duplicate resource'); const s = mockSession(); resources.set(id, s); return s }, async releaseSession(id) { await resources.get(id)?.close(); resources.delete(id) } },
  storage: { get: key => structuredClone(data.get(key)), set: (key, value) => data.set(key, structuredClone(value)) }, log() {},
 }
}
