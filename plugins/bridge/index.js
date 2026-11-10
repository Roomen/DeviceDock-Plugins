import { registerBridgeTools } from './mcp.js'
import { createBridgeService } from './service.js'
import { ui } from '../shared/ui.js'
export function activate(host) {
 const service = createBridgeService(host), bridge = service.controller, view = ui(host, 'USB BLE bridge / GATT tools')
 const offTools = registerBridgeTools(host, service)
 const registered = host.registerService('org.devicedock.bridge.v1', service), transport = host.registerTransport(service.transport)
 const preflight = host.prepareDeactivate(() => { if (service.isBusy()) throw Error('Stop scanning, disconnect profile session and wait for bridge work before disabling') })
 view.make('p', 'USB bridge uses the existing NDJSON firmware protocol at 2 Mbps. Keep the bridge open and reset its firmware until ready arrives before connecting a BLE device. Saved GATT profiles appear in the common connection selector.')
 let portId, gattGeneration
 view.button('Select & open USB bridge', async () => { portId = service.selectPort(await host.resources.requestPort('serial')); await bridge.run('open', { deviceId: portId }) })
 view.button('Close USB bridge', () => bridge.run('close'))
 view.button('Start scan', () => bridge.run('scan_start'))
 view.button('Stop scan', () => bridge.run('scan_stop'))
 const name = view.input('Advertising name filter'), uuid = view.input('Advertising service UUID (128-bit)')
 const devices = view.select('Discovered device', []), tx = view.select('TX characteristic', []), rx = view.select('RX characteristic', [])
 const response = view.select('Write mode', [['true', 'With response'], ['false', 'Without response']]), chunk = view.input('Profile chunk bytes', '20', 'number')
 const hex = view.input('Write HEX', '01'), passkey = view.input('Pair passkey / confirmation (1=yes, 0=no)', '', 'password')
 passkey.autocomplete = 'off'
 const details = view.make('pre'), events = view.make('pre')
 const params = () => ({ generation: gattGeneration, characteristicId: rx.value })
 view.button('Connect selected device', () => bridge.run('connect', { deviceId: devices.value }))
 view.button('Disconnect device', () => bridge.run('disconnect', params()))
 view.button('Pair', () => bridge.run('pair', params()))
 view.button('Submit pairing input', () => { const value = Number(passkey.value); passkey.value = ''; return bridge.run('passkey', { ...params(), passkey: value }) })
 view.button('Reject pairing confirmation', () => { passkey.value = ''; return bridge.run('passkey', { ...params(), passkey: 0 }) })
 view.button('Read RX characteristic', async () => { const result = await bridge.run('read', params()); view.status.textContent = 'Read base64: ' + result.base64 })
 view.button('Write TX characteristic', () => bridge.run('write', { generation: gattGeneration, characteristicId: tx.value, hex: hex.value, response: response.value === 'true' }))
 view.button('Subscribe RX', () => bridge.run('subscribe', { ...params(), on: true }))
 view.button('Unsubscribe RX', () => bridge.run('subscribe', { ...params(), on: false }))
 view.button('Save serial profile', () => { service.saveProfile(tx.value, rx.value, response.value === 'true', Number(chunk.value)); view.status.textContent = 'Profile saved; select USB BLE bridge profile in common connections' })
 view.button('Resolve saved profile', () => { const profile = service.savedProfile(), resolved = bridge.resolveProfile(profile); tx.value = resolved.tx; rx.value = resolved.rx; response.value = String(profile.response); chunk.value = String(profile.chunkSize) })
 view.button('Remove saved profile', () => service.removeProfile())
 function options(select, rows) {
  const value = select.value; select.replaceChildren()
  for (const [id, label] of rows) { const item = view.make('option', label, select); item.value = id }
  if (rows.some(([id]) => id === value)) select.value = value
 }
 let signature = ''
 function render() {
  const state = bridge.state(), gatt = bridge.gatt(); gattGeneration = gatt.generation
  view.status.textContent = `${state.phase} · ${state.synchronized ? 'ready' : 'reset bridge firmware required'}${state.challenge ? ' · pairing ' + state.challenge.action + ': ' + state.challenge.value : ''}`
  options(devices, bridge.devices({ name: name.value, serviceUuid: uuid.value }).map(d => [d.deviceId, `${d.name} · RSSI ${d.rssi ?? '?'}${d.connectable ? '' : ' · not connectable'}`]))
  const next = JSON.stringify(gatt)
  if (next !== signature) { signature = next; const rows = gatt.characteristics; const label = c => [c.characteristicId, `${c.service}/${c.uuid} · props ${c.props}`]; options(tx, rows.filter(c => c.props & (response.value === 'true' ? 8 : 4)).map(label)); options(rx, rows.filter(c => c.props & 0x30).map(label)); details.textContent = JSON.stringify(gatt, null, 2) }
  events.textContent = JSON.stringify(bridge.logs(), null, 2)
 }
 response.addEventListener('change', () => { signature = ''; render() }, { signal: host.signal })
 const off = bridge.subscribe(() => view.run(render))
 name.addEventListener('change', () => view.run(render), { signal: host.signal }); uuid.addEventListener('change', () => view.run(render), { signal: host.signal })
 return async () => { await service.dispose(); offTools(); off(); preflight(); registered(); transport(); view.dispose() }
}
