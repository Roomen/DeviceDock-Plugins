const laneSchema = { type: 'string', enum: ['instrument', 'A', 'B'] }
export function registerPowerTools(host, service) {
 if (!host.registerMcpTool) return () => {}
 const disposers = []
 function tool(name, description, properties, required, handler) {
  const allowed = new Set(Object.keys(properties))
  disposers.push(host.registerMcpTool({ name: 'org.devicedock.power.' + name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } }, async (args, context) => {
   if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !allowed.has(key)) || required.some(key => !(key in args))) throw Error('Invalid power tool arguments')
   context.signal.throwIfAborted()
   if ('lane' in properties && !['instrument', 'A', 'B'].includes(args.lane)) throw Error('Select instrument, A or B')
   return handler(args, context)
  }))
 }
 tool('blu_state', 'Power instrument state (legacy blu_state).', {}, [], () => service.status())
 tool('blu_set_voltage', 'Set regulator voltage in millivolts (legacy blu_set_voltage).', { lane: laneSchema, millivolts: { type: 'integer', minimum: 500, maximum: 5000 } }, ['lane', 'millivolts'], async (args, context) => {
  if (!Number.isInteger(args.millivolts) || args.millivolts < 500 || args.millivolts > 5000) throw Error('millivolts must be an integer from 500 to 5000')
  await service.setVoltage(args.lane, args.millivolts, context); return service.status()
 })
 tool('blu_set_power', 'Set DUT power; enabling requires a known regulator voltage (legacy blu_set_power).', { lane: laneSchema, on: { type: 'boolean' } }, ['lane', 'on'], async (args, context) => {
  if (typeof args.on !== 'boolean') throw Error('on must be boolean')
  const state = service.status()
  if (args.on && state.voltage == null) throw Error('Set regulator voltage before enabling power')
  await service.setPower(args.lane, args.on, state.voltage ?? 3300, context); return service.status()
 })
 tool('blu_capture_start', 'Start calibrated current capture (legacy blu_capture_start). Configure advanced triggers in the plugin UI.', { lane: laneSchema, rateHz: { type: 'number', minimum: 0.000001, maximum: 100000 }, metadata: { type: 'string', maxLength: 65536 } }, ['lane'], async (args, context) => {
  if (args.rateHz != null && (!Number.isFinite(args.rateHz) || args.rateHz <= 0 || args.rateHz > 100000) || args.metadata != null && (typeof args.metadata !== 'string' || args.metadata.length > 65536)) throw Error('Invalid rate or calibration metadata')
  if (service.status().voltage == null) throw Error('Set regulator voltage before capture')
  await service.start(args.lane, { rateHz: args.rateHz ?? 100000, metadata: args.metadata ?? '', warmupSeconds: .25 }, context); return service.status()
 })
 tool('blu_capture_stop', 'Stop capture and await disk drain (legacy blu_capture_stop).', { lane: laneSchema }, ['lane'], async (args, context) => { await service.stop(args.lane, context); return service.status() })
 tool('blu_capture_summary', 'Retained current statistics, integrated charge and energy, with units (legacy blu_capture_summary).', {}, [], () => service.summary())
 return () => { for (const off of disposers.reverse()) off() }
}
