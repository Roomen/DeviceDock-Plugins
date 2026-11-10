import { createWebBluetoothProvider } from './ble.js'
import { ui } from '../shared/ui.js'
export function activate(host) {
 const view = ui(host, 'Wireless transports'), disposers = [], bluetooth = globalThis.navigator?.bluetooth
 const available = []
 let web
 if (bluetooth?.requestDevice) { web = createWebBluetoothProvider(bluetooth); disposers.push(host.registerTransport(web)); available.push([web.id, web.title]); view.make('p', 'BLE UART available in the common connection selector (Nordic UART and HM-10). Received bytes use the normal session and protocol view.') }
 else view.make('p', 'Web Bluetooth unavailable on this platform.')
 for (const [name, key] of [['Native BLE', 'org.devicedock.native.ble.v1'], ['Bluetooth SPP', 'org.devicedock.native.spp.v1']]) {
  const provider = host.getService(key)
  if (provider?.requestPort) { disposers.push(host.registerTransport(provider)); available.push([provider.id, name]); view.make('p', name + ' available in the common connection selector') }
  else view.make('p', name + ' unavailable: requires a client built with this native driver')
 }
 view.make('p', 'Connect and disconnect BLE/SPP through the host connection selector for lane A or B. Select a registered wireless driver there; the host owns lane routing and device permissions.')
 const states = view.make('output')
 const render = () => { states.textContent = ['A', 'B'].map(id => `Lane ${id}: ${host.session(id).state}`).join(' · ') }
 for (const id of ['A', 'B']) disposers.push(host.session(id).subscribe(render))
 render()
 const preflight = host.prepareDeactivate(() => { if (web && [...web.ports.values()].some(p => p.state !== 'closed')) throw Error('Disconnect Bluetooth sessions before disabling wireless') })
 return async () => { await web?.dispose(); preflight(); for (const off of disposers.reverse()) off(); view.dispose() }
}
