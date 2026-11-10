// Explicit opt-in bridge tools share the UI controller and its serialized queue.
export function registerBridgeTools(host, service) {
 if (!host.registerMcpTool) return () => {}
 const bridge = service.controller, disposers = [], generation = { type: 'integer', minimum: 0 }, characteristicId = { type: 'string', minLength: 1, maxLength: 128 }
 function tool(action, properties = {}, required = [], read) {
  const definition = { name: 'org.devicedock.bridge.ble_' + action, description: 'USB BLE bridge ' + action + '; UI-selected bridge only.', timeoutMs: 60000, inputSchema: { type: 'object', properties, required, additionalProperties: false } }
  disposers.push(host.registerMcpTool(definition, async (args, context) => {
   if (!args || typeof args !== 'object' || Object.keys(args).some(k => !Object.hasOwn(properties, k)) || required.some(k => !Object.hasOwn(args, k))) throw Error('Invalid bridge arguments')
   context.signal.throwIfAborted(); if (read) return read(args)
   const expected = bridge.state().generation; let committed = false
   const check = () => { context.signal.throwIfAborted(); if (!committed && bridge.state().generation !== expected) throw Error('Bridge request connection changed') }
   return bridge.run(action, args, { step: check, beforeWrite: async () => { check(); if (!committed) { await context.commit(); check(); committed = true }; check() } })
  }))
 }
 tool('state', {}, [], () => { const { challenge, ...state } = bridge.state(); return state }); tool('ports', {}, [], () => bridge.ports()); tool('devices', {}, [], () => bridge.devices()); tool('gatt', {}, [], () => bridge.gatt()); tool('events', {}, [], () => bridge.logs())
 tool('open', { deviceId: { type: 'string', minLength: 1, maxLength: 128 } }, ['deviceId']); tool('close'); tool('scan_start'); tool('scan_stop')
 tool('connect', { deviceId: { type: 'string', minLength: 1, maxLength: 128 } }, ['deviceId'])
 for (const action of ['disconnect', 'pair']) tool(action, { generation }, ['generation'])
 tool('passkey', { generation, passkey: { type: 'integer', minimum: 0, maximum: 999999 } }, ['generation', 'passkey'])
 tool('read', { generation, characteristicId }, ['generation', 'characteristicId'])
 tool('write', { generation, characteristicId, hex: { type: 'string', minLength: 2, maxLength: 1024, pattern: '^(?:[a-fA-F0-9]{2})+$' }, response: { type: 'boolean' } }, ['generation', 'characteristicId', 'hex'])
 tool('subscribe', { generation, characteristicId, on: { type: 'boolean' } }, ['generation', 'characteristicId', 'on'])
 return () => { for (const off of disposers.reverse()) off() }
}
