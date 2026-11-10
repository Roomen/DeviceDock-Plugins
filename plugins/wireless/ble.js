// Profiles and ATT chunking derived from transport-ble.js; rewritten for late-open cleanup.
import { createStreamPort } from '../shared/stream-port.js'
export const profiles = [
 { service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', write: '6e400002-b5a3-f393-e0a9-e50e24dcca9e', notify: '6e400003-b5a3-f393-e0a9-e50e24dcca9e' },
 { service: 0xffe0, write: 0xffe1, notify: 0xffe1 },
]
export function createBleDriver(device) {
 let epoch = 0, live = null, pending = null, writes = Promise.resolve()
 async function cleanup(connection) {
  if (!connection) return
  connection.rx?.removeEventListener('characteristicvaluechanged', connection.value)
  device.removeEventListener('gattserverdisconnected', connection.gone)
  // A physically disconnected server has no notifications left to stop.
  try { if (device.gatt.connected !== false) await connection.rx?.stopNotifications() }
  catch (error) { if (device.gatt.connected !== false) throw error }
  finally { connection.server?.disconnect() }
 }
 return {
  getInfo: () => ({ transport: 'ble', productName: device.name || 'BLE UART' }),
  async open(options, sink) {
   if (live) throw Error('BLE cleanup required before open')
   const token = ++epoch, connection = {}; live = connection
   const check = () => { if (token !== epoch) throw Error('BLE open cancelled') }
   connection.gone = () => { if (token === epoch) { ++epoch; sink.lost(Error('BLE disconnected')) } }
   device.addEventListener('gattserverdisconnected', connection.gone)
   pending = (async () => {
    try {
     connection.server = await device.gatt.connect(); check()
     for (const profile of profiles) {
      let service
      try { service = await connection.server.getPrimaryService(profile.service) } catch { check(); continue }
      check(); connection.tx = await service.getCharacteristic(profile.write); check()
      connection.rx = profile.notify === profile.write ? connection.tx : await service.getCharacteristic(profile.notify); check(); break
     }
     if (!connection.rx) throw Error('No supported UART GATT service')
     connection.value = e => { if (token !== epoch) return; const v = e.target.value; sink.data(new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice()) }
     connection.rx.addEventListener('characteristicvaluechanged', connection.value)
     await connection.rx.startNotifications(); check(); live = connection
    } catch (e) { await cleanup(connection); if (live === connection) live = null; throw e }
   })()
   return pending
  },
  write(bytes) {
   const token = epoch, current = live, copy = bytes.slice()
   const job = writes.then(async () => {
    if (!current || token !== epoch) throw Error('BLE disconnected')
    for (let offset = 0; offset < copy.length; offset += 20) {
     if (token !== epoch) throw Error('BLE disconnected')
     const chunk = copy.slice(offset, offset + 20), tx = current.tx
     if (tx.properties?.writeWithoutResponse && tx.writeValueWithoutResponse) await tx.writeValueWithoutResponse(chunk)
     else if (tx.writeValueWithResponse) await tx.writeValueWithResponse(chunk)
     else await tx.writeValue(chunk)
     if (token !== epoch) throw Error('BLE disconnected')
    }
   })
   writes = job.catch(() => {}); return job
  },
  async close() {
   ++epoch; await pending?.catch(() => {}); await writes
   const previous = live
   await cleanup(previous); if (live === previous) live = null
  },
 }
}
export function createWebBluetoothProvider(bluetooth) {
 const cache = new Map()
 return {
  id: 'org.devicedock.ble', title: 'Bluetooth LE UART', ports: cache,
  async requestPort() {
   const device = await bluetooth.requestDevice({ filters: profiles.map(p => ({ services: [p.service] })), optionalServices: profiles.map(p => p.service) })
   const key = device.id || device
   if (!cache.has(key)) cache.set(key, createStreamPort(createBleDriver(device)))
   return cache.get(key)
  },
  async dispose() { for (const port of cache.values()) await port.close(); cache.clear() },
 }
}
