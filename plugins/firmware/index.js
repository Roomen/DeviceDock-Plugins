import { registerFirmwareTools } from './mcp.js'
import { createFirmwareService } from './service.js'
import { ui } from '../shared/ui.js'
export function activate(host) {
 const service = createFirmwareService(host), view = ui(host, 'Device firmware'), offService = host.registerService('org.devicedock.firmware.v1', service)
 const offTools = registerFirmwareTools(host, service)
 const preflight = host.prepareDeactivate(() => { if (service.status().busy) throw Error('Cancel firmware work and wait before disabling') })
 view.make('p', 'Original, compressed and differential package validation. An enabled SEK firmware codec is required for device transfer. A licensed patch provider is required to generate compressed/differential packages. Execute sent does not confirm successful flashing.')
 const lane = view.select('Communication session', [['A', 'A'], ['B', 'B']]), file = view.input('Firmware / package', '', 'file'), base = view.input('Exact differential base', '', 'file')
 file.accept = base.accept = '.bin'
 const mode = view.select('Package format', [['origin', 'Original'], ['compress', 'Compressed (requires patch provider)'], ['diff', 'Differential (requires exact base + patch provider)']])
 const size = view.input('Chunk bytes', '128', 'number'), user = view.input('Package description')
 const progress = view.make('progress'); progress.max = 1; progress.value = 0
 const detail = view.make('pre'); let current = null, targetBytes = null, baseBytes = null
 const versions = view.make('output', 'Device version unknown'), stats = view.make('output'), grid = view.make('div'); grid.setAttribute('aria-label', 'Requested firmware chunks')
 let started = 0, retries = 0, requests = 0, lastTargetVersion = null
 async function read(input) { const selected = input === file ? targetBytes : baseBytes; if (selected) return selected.slice(); const f = input.files?.[0]; if (!f || f.size > 32_000_000) throw Error('Select a firmware file under 32 MB'); return new Uint8Array(await f.arrayBuffer()) }
 view.button('Inspect file', async () => { const bytes = await read(file); const classification = service.core.classify(bytes); lastTargetVersion = service.core.embeddedVersion(bytes); if (classification.kind === 'package') { const verified = service.verifyPackage(bytes); current = verified.data; detail.textContent = JSON.stringify({ ...classification, ...verified, data: undefined }, null, 2) } else { current = null; detail.textContent = JSON.stringify(classification, null, 2) } })
 view.button('Build & save package', async () => { current = await service.package(mode.value, await read(file), mode.value === 'diff' ? await read(base) : undefined, user.value); const checked = service.verifyPackage(current); lastTargetVersion = checked.version; detail.textContent = JSON.stringify({ type: checked.type, version: checked.version, packageBytes: current.length, sourceBytes: (await read(file)).length, ratio: current.length / (await read(file)).length }, null, 2); view.download(current, 'firmware-' + mode.value + '.bin'); view.status.textContent = 'Package generated and CRC verified' })
 view.button('Upgrade selected package', async () => { const bytes = current || await read(file); service.verifyPackage(bytes); await service.upgrade(lane.value, bytes, { chunkSize: Number(size.value) }) })
 view.button('Automatic upgrade raw firmware', async () => { await service.upgradeAutomatic(lane.value, await read(file), { chunkSize: Number(size.value), userDefine: user.value }) })
 view.button('Query / verify installed version', async () => { const version = await service.queryVersion(lane.value); versions.textContent = `Device: ${version}${lastTargetVersion ? ` · target: ${lastTargetVersion} · ${service.core.sameVersion(version, lastTargetVersion) ? 'version matches (not byte verification)' : 'version differs'}` : ''}` })
 view.button('Cancel task', () => service.cancel())
 view.button('Add raw firmware to local library', async () => { const bytes = await read(file); const result = await service.addToLibrary(file.files?.[0]?.name || 'Library selection', bytes); detail.textContent = JSON.stringify({ ...result, entries: await service.library() }, null, 2) })
 const library = view.select('Local firmware library', [])
 async function refreshLibrary() {
  library.replaceChildren()
  for (const row of await service.library()) { const option = view.make('option', `${row.name} · ${row.version} · ${row.size} bytes · ${row.id.slice(0, 12)}`, library); option.value = row.id }
 }
 view.button('Refresh library', refreshLibrary)
 view.button('Use library as target firmware', async () => { const row = await service.readLibrary(library.value); targetBytes = row.data; current = null; lastTargetVersion = row.version; detail.textContent = `Target: ${row.name} (${row.version})` })
 view.button('Use library as exact differential base', async () => { const row = await service.readLibrary(library.value); baseBytes = row.data; detail.textContent = `Base: ${row.name} (${row.version})` })
 view.button('Export library firmware', async () => { const row = await service.readLibrary(library.value); view.download(row.data, row.name || 'firmware.bin') })
 view.button('Remove library firmware', async () => { await service.removeFromLibrary(library.value); await refreshLibrary() })
 view.make('p', 'Legacy library migration: export raw .bin files or a JSON array of {name, data:[byte,...]} from the old application, then import here. Versions, CRC and SHA are recomputed; old login/session data is never imported. Different application origins cannot read each other’s browser storage.')
 const legacy = view.input('Import legacy firmware library JSON', '', 'file'); legacy.accept = '.json'
 legacy.addEventListener('change', () => view.run(async () => { const f = legacy.files?.[0]; if (!f || f.size > 140_000_000) throw Error('Select library JSON under 140 MB'); const result = await service.importLibraryJSON(JSON.parse(await f.text())); await refreshLibrary(); detail.textContent = JSON.stringify(result, null, 2); view.status.textContent = `${result.ids.length} firmware records imported; ${result.evicted.length} older records evicted` }), { signal: host.signal })
 view.button('Export library JSON', async () => { const entries = []; for (const meta of await service.library()) { const row = await service.readLibrary(meta.id); entries.push({ name: row.name, data: Array.from(row.data) }) }; view.download(JSON.stringify({ entries }), 'firmware-library.json', 'application/json') })
 const off = service.subscribe(state => {
  progress.value = state.progress || 0
  view.status.textContent = state.error || state.message || `${state.phase}: ${state.sent ?? 0}/${state.total ?? 0}`
  if (state.phase === 'query') { started = performance.now(); requests = retries = 0; grid.replaceChildren() }
  if (state.deviceVersion) versions.textContent = 'Before upgrade: ' + state.deviceVersion
  if (state.phase === 'fallback') { grid.replaceChildren(); requests = retries = 0 }
  if (state.phase === 'transfer') {
   requests++; if (state.resend) retries++
   // Render at most 256 buckets even for very large transfers.
   const buckets = Math.min(state.total, 256)
   while (grid.children.length < buckets) { const item = view.make('span', '·', grid); item.style.cssText = 'display:inline-block;padding:2px' }
   const bucket = Math.min(buckets - 1, Math.floor(state.chunkIndex / state.total * buckets)), item = grid.children[bucket]
   if (item) { item.textContent = state.resend ? '↻' : '■'; item.title = `Last request: chunk ${state.chunkIndex}${state.resend ? ' (retry)' : ''}` }
   const elapsed = (performance.now() - started) / 1000
   stats.textContent = `${state.sent}/${state.total} unique chunks · ${requests} requests · ${retries} retransmits · ${elapsed.toFixed(1)} s · ${(state.bytesSent / Math.max(elapsed, .001)).toFixed(0)} bytes/s`
  }
 })
 file.addEventListener('change', () => { current = null; targetBytes = null }, { signal: host.signal })
 base.addEventListener('change', () => { baseBytes = null; current = null }, { signal: host.signal })
 return async () => { await service.dispose(); off(); preflight(); offTools(); offService(); view.dispose() }
}
