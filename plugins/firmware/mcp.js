export function registerFirmwareTools(host, service) {
 if (!host.registerMcpTool) return () => {}
 const disposers = [], lane = { type: 'string', enum: ['A', 'B'] }, id = { type: 'string', pattern: '^[a-f0-9]{64}$' }
 function tool(name, description, properties, required, run, timeoutMs = 30000) {
  disposers.push(host.registerMcpTool({ name: 'org.devicedock.firmware.' + name, description, timeoutMs, inputSchema: { type: 'object', properties, required, additionalProperties: false } }, (args, context) => {
   if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !(k in properties)) || required.some(k => !(k in args))) throw Error('Invalid firmware arguments')
   if ('lane' in properties && !['A', 'B'].includes(args.lane) || 'id' in properties && !/^[a-f0-9]{64}$/.test(args.id)) throw Error('Invalid lane or firmware SHA-256 identifier')
   context.signal.throwIfAborted(); return run(args, context)
  }))
 }
 tool('library_list', 'List local firmware metadata; no binary payload.', {}, [], () => service.library())
 tool('query_version', 'Query device firmware version using SEK transaction.', { lane }, ['lane'], (a, c) => service.queryVersion(a.lane, c))
 tool('upgrade_library_original', 'Upgrade a SHA-256 identified local raw firmware using original package; returns execute-sent, not flashed verification.', { lane, id, chunkSize: { type: 'integer', minimum: 1, maximum: 512 } }, ['lane', 'id'], (a, c) => {
  if (a.chunkSize != null && (!Number.isInteger(a.chunkSize) || a.chunkSize < 1 || a.chunkSize > 512)) throw Error('chunkSize must be 1–512')
  return service.upgradeLibrary(a.lane, a.id, { chunkSize: a.chunkSize ?? 128, context: c })
 }, 1260000)
 return () => { for (const off of disposers.reverse()) off() }
}
