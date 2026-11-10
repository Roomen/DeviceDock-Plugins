import { create } from './core.js'
import { createStreamPort } from '../shared/stream-port.js'
export function createBridgeService(host) {
 const selected = new Map(), profilePorts = new Set()
 let next = 0, chosen = null, disposed = false
 const controller = create({
  namespace: 'devicedock-usb-bridge',
  blocked: () => disposed || host.signal.aborted,
  isPinned: () => [...profilePorts].some(p => p.state !== 'closed'),
  createStreamPort(driver) { const port = createStreamPort(driver); profilePorts.add(port); return port },
  ports: async () => [...selected].map(([deviceId]) => ({ deviceId, name: 'Selected USB bridge' })),
  async open(id, data, lost, check) {
   const port = selected.get(id); if (!port) throw Error('Select a USB bridge port first')
   const session = host.resources.createSession('bridge')
   let generation, release = null
   const off = session.subscribe(row => { if (generation != null && row.generation !== generation) { lost(); return }; if (row.direction === 'rx') data(row.bytes) })
   try {
    await session.open(port, { baudRate: 2000000, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' }); generation = session.generation; check(); await session.setSignals?.({ dataTerminalReady: false, requestToSend: false }); check(); release = session.claim('org.devicedock.bridge.v1')
    return {
     write(bytes, beforeWrite) { return session.send(bytes, { owner: 'org.devicedock.bridge.v1', generation, beforeWrite }) },
     async close() { await host.resources.releaseSession('bridge'); off(); release?.() },
    }
   } catch (e) { await host.resources.releaseSession('bridge'); off(); release?.(); throw e }
  },
 })
 return {
  controller,
  selectPort(port) { if (disposed) throw Error('Bridge inactive'); for (const [id, existing] of selected) if (existing === port) return id; const id = 'usb-' + (++next); selected.set(id, port); return id },
  savedProfile: () => chosen || host.storage.get('profile'),
  removeProfile() { if ([...profilePorts].some(p => p.state !== 'closed')) throw Error('Disconnect profile sessions first'); chosen = null; host.storage.set('profile', null) },
  saveProfile(tx, rx, response = true, chunkSize = 20) { chosen = controller.profile(tx, rx, response, chunkSize); host.storage.set('profile', chosen); return chosen },
  transport: {
   id: 'org.devicedock.usb-ble-bridge', title: 'USB BLE bridge profile',
   async requestPort() { if (disposed) throw Error('Bridge inactive'); const profile = chosen || host.storage.get('profile'); controller.resolveProfile(profile); return controller.createProfilePort(profile) },
  },
  isBusy: () => controller.isBusyForUpdate() || [...profilePorts].some(p => p.state !== 'closed'),
  async dispose() { for (const port of profilePorts) await port.close(); await controller.release(); disposed = true; selected.clear(); profilePorts.clear() },
 }
}
