import { createPatchService } from './service.js'
export function activate(host) {
 const service = createPatchService(host)
 const check = host.prepareDeactivate(() => { if (service.busy) throw Error('Cancel firmware patch work and wait before disabling') })
 const off = host.registerService('org.devicedock.firmware.patch.v1', service)
 return () => { service.dispose(); off(); check() }
}
