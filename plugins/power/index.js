import { registerPowerTools } from './mcp.js'
import { createPowerService } from './service.js'
import { plot } from '../shared/charts.js'
import { EdgeDetector } from './trigger.js'
import { ui } from '../shared/ui.js'
export function activate(host) {
 const service = createPowerService(host), view = ui(host, 'Power instrument & offline analysis')
 const offTools = registerPowerTools(host, service)
 const offService = host.registerService('org.devicedock.power.v1', service)
 const offPreflight = host.prepareDeactivate(() => { if (service.status().busy) throw Error('Stop acquisition and wait for power operations before disabling') })
 const lane = view.select('Device session', [['instrument', 'Dedicated instrument'], ['A', 'Communication A'], ['B', 'Communication B']])
 view.make('p', 'Connect the BLU instrument, read calibration, then start acquisition. Offline JSON captures require no connected instrument. RAM preview retains 2 million samples. Enable durable recording to retain data beyond RAM; disk-full stops acquisition unless rolling is selected. Interrupted recording journals remain readable.')
 view.button('Connect USB instrument', async () => {
  await service.connect(await host.resources.requestPort('serial', { filters: [{ usbVendorId: 0x15a2, usbProductId: 0x300a }] })); lane.value = 'instrument'; metadata.value = await service.metadata('instrument'); const probe = await service.probePower('instrument', metadata.value); view.status.textContent = `Instrument connected · power ${probe.on ?? 'unknown'} (probed)`
 })
 view.button('Disconnect instrument', () => service.disconnect())
 const voltage = view.input('Output (mV)', '3300', 'number'), rate = view.input('Capture rate (Hz)', '1000', 'number')
 const metadata = view.make('textarea'); metadata.setAttribute('aria-label', 'BLU calibration metadata'); metadata.placeholder = 'Calibration metadata (R/O fields), or read from device'
 view.button('Read calibration', async () => { metadata.value = await service.metadata(lane.value); view.status.textContent = 'Calibration received' })
 view.button('Set voltage', () => service.setVoltage(lane.value, Number(voltage.value)))
 view.button('Power on', () => service.setPower(lane.value, true, Number(voltage.value)))
 view.button('Probe DUT power (250 ms)', async () => { results.textContent = JSON.stringify(await service.probePower(lane.value, metadata.value), null, 2) })
 view.button('Power off', () => service.setPower(lane.value, false))
 const edges = [['off', 'Off'], ['rise', 'Rising'], ['fall', 'Falling'], ['either', 'Either']]
 const startEdge = view.select('Acquisition start edge', edges), stopEdge = view.select('Acquisition stop edge', edges)
 const autoLevel = view.select('Trigger level mode', [['manual', 'Manual'], ['auto', 'Auto midpoint / hysteresis']]), warmup = view.input('Warmup seconds (capped at 5000 samples)', '0.25', 'number')
 const trigLevel = view.input('Trigger level (µA)', '100', 'number'), hyst = view.input('Trigger hysteresis (µA)', '1', 'number')
 const pre = view.input('Pretrigger samples', '1000', 'number'), duration = view.input('Duration after trigger (seconds; 0=unlimited)', '0', 'number')
 const recordMode = view.select('Recording mode', [['wave', 'Waveform'], ['long', 'Long statistics (constant memory, no waveform)']])
 const durable = view.select('Recording storage', [['false', 'RAM preview only'], ['true', 'Durable disk journal']]), budget = view.input('Disk budget (MB)', '128', 'number')
 const rolling = view.select('Disk full policy', [['false', 'Stop and preserve'], ['true', 'Roll oldest blocks']])
 view.button('Start capture', () => service.start(lane.value, { rateHz: Number(rate.value), metadata: metadata.value, mode: recordMode.value, warmupSeconds: Number(warmup.value), trigger: { autoLevel: autoLevel.value === 'auto', start: startEdge.value, stop: stopEdge.value, level: Number(trigLevel.value), hysteresis: Number(hyst.value), preSamples: Number(pre.value), durationSeconds: Number(duration.value) }, durable: durable.value === 'true', budgetBytes: Number(budget.value) * 1e6, rolling: rolling.value === 'true' }))
 view.button('Stop capture', () => service.stop(service.status().captureLane || lane.value))
 view.button('Arm raw RX capture (4 MiB)', () => { service.captureRaw(); view.status.textContent = 'Raw capture armed for next acquisition' })
 view.button('Export raw RX bytes', () => { view.download(service.dumpRaw(), 'power-raw.bin'); results.textContent = JSON.stringify(service.streamStats(), null, 2) })
 view.button('BLU command reference', () => { view.status.textContent = 'Metadata: GET_META_DATA; capture: AVERAGE_START / AVERAGE_STOP; regulator: 500–5000 mV; DUT power: on/off. RX/TX bytes and timing are available in the shared host log and replay.' })
 const canvas = view.make('canvas'); canvas.width = 900; canvas.height = 220; canvas.setAttribute('aria-label', 'Current waveform')
 const eventCanvas = view.make('canvas'); eventCanvas.width = 900; eventCanvas.height = 65; eventCanvas.setAttribute('aria-label', 'Communication A/B RX TX events aligned to waveform')
 const eventDetail = view.make('output'); let visibleEvents = []
 eventCanvas.addEventListener('pointermove', e => { const fraction = (e.clientX - eventCanvas.getBoundingClientRect().left) / eventCanvas.getBoundingClientRect().width, t = Number(from.value) + fraction * (Number(to.value) - Number(from.value)); const nearest = visibleEvents.reduce((a, row) => !a || Math.abs(row.seconds - t) < Math.abs(a.seconds - t) ? row : a, null); eventDetail.textContent = nearest ? `${nearest.lane} ${nearest.direction} · ${nearest.bytes} bytes · ${nearest.seconds.toFixed(6)} s · ${nearest.hex}` : 'No captured serial events' }, { signal: host.signal })
 const from = view.input('Selection start (seconds)', '0', 'number'), to = view.input('Selection end (seconds)', '10', 'number')
 const threshold = view.input('Threshold (µA)', '100', 'number'), capacity = view.input('Battery capacity (mAh)', '1000', 'number'), period = view.input('Cycle length (samples)', '100', 'number')
 const results = view.make('pre')
 view.button('Capture summary / long statistics', () => { results.textContent = JSON.stringify(service.summary(), null, 2) })
 view.button('Export long statistics', () => { const s = service.summary(); view.download(JSON.stringify(s, null, 2), 'power-statistics.json', 'application/json') })
 const follow = view.select('Viewport', [['follow', 'Live follow'], ['manual', 'Manual selection']]), scale = view.select('Current scale', [['linear', 'Linear'], ['log', 'Signed log']])
 const displayTrigger = view.select('Display trigger', edges), holdoff = view.input('Display trigger holdoff (seconds)', '0.1', 'number')
 function render() {
  const blocks = service.store.blocks, first = blocks[0]?.times[0], last = blocks.at(-1)?.times.at(-1)
  if (follow.value === 'follow' && last != null) {
   const span = Math.max(0.00001, Number(to.value) - Number(from.value)); let end = last
   if (displayTrigger.value !== 'off') {
    const tail = service.store.selection(Math.max(first, last - span * 4), last), mm = service.analysis.basicStats(tail), level = autoLevel.value === 'auto' ? (mm.min + mm.max) / 2 : Number(trigLevel.value), hysteresis = autoLevel.value === 'auto' ? Math.max(mm.pp * .03, Math.abs(level) * .01, 1e-9) : Number(hyst.value)
    const detector = new EdgeDetector(displayTrigger.value, level, hysteresis); let previous = -Infinity
    for (const block of blocks) for (let i = 0; i < block.values.length; i++) {
     const t = block.times[i]
     if (t < last - span * 2) continue
     if (detector.push(block.values[i]) && t - previous >= Number(holdoff.value) && t + span * 0.75 <= last) { previous = t; end = t + span * 0.75 }
    }
   }
   from.value = String(Math.max(first, end - span)); to.value = String(end)
  }
  const events = service.serialEvents(), ctx = eventCanvas.getContext('2d'); visibleEvents = events.rows.filter(row => row.seconds != null && row.seconds >= Number(from.value) && row.seconds <= Number(to.value)); if (ctx) { ctx.clearRect(0, 0, eventCanvas.width, eventCanvas.height); for (const row of visibleEvents) { const x = (row.seconds - Number(from.value)) / (Number(to.value) - Number(from.value) || 1) * eventCanvas.width, y = row.lane === 'A' ? 10 : 35; ctx.fillStyle = row.direction === 'tx' ? '#b57716' : '#178872'; ctx.fillRect(x, y, 2, 15) }; ctx.fillStyle = '#737373'; ctx.fillText(`A / B · TX amber / RX green · ${events.dropped} earlier events dropped · live receive-clock alignment`, 8, 62) }
  plot(minimap, service.store.series());
  plot(canvas, service.store.series(Number(from.value), Number(to.value)), { log: scale.value === 'log' })
 }
 view.button('Fullscreen waveform', async () => { if (canvas.requestFullscreen) await canvas.requestFullscreen() })
 const minimap = view.make('canvas'); minimap.width = 900; minimap.height = 70; minimap.setAttribute('aria-label', 'Retained capture overview')
 minimap.addEventListener('click', e => { const first = service.store.blocks[0]?.times[0], last = service.store.blocks.at(-1)?.times.at(-1); if (first == null) return; const center = first + (last - first) * (e.clientX - minimap.getBoundingClientRect().left) / minimap.getBoundingClientRect().width, half = (Number(to.value) - Number(from.value)) / 2; follow.value = 'manual'; from.value = String(center - half); to.value = String(center + half); render() }, { signal: host.signal })
 view.button('Show all retained samples', () => { follow.value = 'manual'; from.value = String(service.store.blocks[0]?.times[0] ?? 0); to.value = String(service.store.blocks.at(-1)?.times.at(-1) ?? 10); render() })
 function zoom(factor) { follow.value = 'manual'; const a = Number(from.value), b = Number(to.value), mid = (a + b) / 2; from.value = String(mid - (b - a) * factor / 2); to.value = String(mid + (b - a) * factor / 2); render() }
 view.button('Zoom in', () => zoom(0.5)); view.button('Zoom out', () => zoom(2))
 for (const direction of [-1, 1]) view.button(direction < 0 ? 'Pan earlier' : 'Pan later', () => { follow.value = 'manual'; const a = Number(from.value), b = Number(to.value), delta = (b - a) * 0.5 * direction; from.value = String(a + delta); to.value = String(b + delta); render() })
 let dragStart
 const timeAt = e => Number(from.value) + Math.max(0, Math.min(1, (e.clientX - canvas.getBoundingClientRect().left) / canvas.getBoundingClientRect().width)) * (Number(to.value) - Number(from.value))
 canvas.addEventListener('pointerdown', e => { dragStart = timeAt(e); canvas.setPointerCapture(e.pointerId) }, { signal: host.signal })
 canvas.addEventListener('pointerup', e => { if (dragStart == null) return; const end = timeAt(e); if (Math.abs(end - dragStart) > 1e-9) { follow.value = 'manual'; from.value = String(Math.min(dragStart, end)); to.value = String(Math.max(dragStart, end)); render() }; dragStart = null }, { signal: host.signal })
 for (const input of [from, to, scale, follow, displayTrigger]) input.addEventListener('change', render, { signal: host.signal })
 const spikeWidth = view.input('Minimum spike width (samples)', '1', 'number'), fftSize = view.input('FFT size (0=automatic; max 65536)', '0', 'number'), topK = view.input('FFT peak count', '8', 'number'), derate = view.input('Battery usable capacity factor', '0.9', 'number')
 const fftWindow = view.select('FFT window', [['hann', 'Hann'], ['flattop', 'Flat top'], ['rect', 'Rectangular']]), dc = view.select('FFT DC', [['true', 'Remove DC'], ['false', 'Keep DC']])
 view.make('p', 'Drag the waveform to select a time range. Spectrum x axis is 0 to Nyquist; cycle overlay x axis is one period. Analysis uses only the retained RAM selection; load an archive to inspect its retained tail or export the full disk journal as CSV.')
 const spectrum = view.make('canvas'), cycles = view.make('canvas'), histogram = view.make('canvas')
 for (const [c, label] of [[spectrum, 'FFT magnitude'], [cycles, 'Cycle mean'], [histogram, 'Current distribution']]) { c.width = 900; c.height = 180; c.setAttribute('aria-label', label) }
 const snap = view.select('Cursor edge snapping', [['rise', 'Rising'], ['fall', 'Falling'], ['either', 'Either']])
 function edgesInSelection() { const edge = new EdgeDetector(snap.value, Number(trigLevel.value), Number(hyst.value)), series = service.store.series(Number(from.value), Number(to.value)), times = []; for (let i = 0; i < series.values.length; i++) if (edge.push(series.values[i])) times.push(series.times[i]); return times }
 view.button('Measure edge period / set cycle length', () => { const edges = edgesInSelection(); if (edges.length < 2) throw Error('Select at least two edges'); const seconds = (edges.at(-1) - edges[0]) / (edges.length - 1), rate = service.store.blocks[0]?.rateHz; period.value = String(Math.round(seconds * rate)); results.textContent = `Period ${seconds} s · frequency ${1 / seconds} Hz`; from.value = String(edges[0]); to.value = String(edges[1]); follow.value = 'manual'; render() })
 view.button('Snap cursors to outer selected edges', () => { const edges = edgesInSelection(); if (edges.length < 2) throw Error('Select at least two edges'); from.value = String(edges[0]); to.value = String(edges.at(-1)); follow.value = 'manual'; render() })
 const peakList = view.make('div'); peakList.setAttribute('aria-label', 'FFT peaks'); const spectrumReadout = view.make('output'); let lastSpectrum
 const analyzeSelection = () => {
  const result = service.analyze({ from: Number(from.value), to: Number(to.value), threshold: Number(threshold.value), capacityMah: Number(capacity.value), periodSamples: Number(period.value), spikeOptions: { minWidthPts: Number(spikeWidth.value) }, batteryOptions: { derate: Number(derate.value) }, fftOptions: { nfft: Number(fftSize.value) || undefined, topK: Number(topK.value), window: fftWindow.value, removeDc: dc.value === 'true' } }); results.textContent = JSON.stringify(result, (_, value) => ArrayBuffer.isView(value) ? Array.from(value).slice(0, 2048) : value, 2)
  plot(spectrum, result.spectrum.mags); plot(cycles, result.cycles.mean, { domain: [result.stats.min, result.stats.max] }); for (const cycle of result.cycles.cycles || []) plot(cycles, cycle, { domain: [result.stats.min, result.stats.max], overlay: true, color: '#8796a0' })
  const values = service.store.selection(Number(from.value), Number(to.value)), bins = new Float64Array(64), span = result.stats.pp || 1
  for (const value of values) bins[Math.min(63, Math.floor((value - result.stats.min) / span * 63))]++
  plot(histogram, bins); render(); lastSpectrum = result.spectrum; peakList.replaceChildren(); for (const peak of result.spectrum.peaks || []) view.button(`${peak.freqHz.toPrecision(5)} Hz · ${peak.magUA.toPrecision(5)} · use cycle`, () => { period.value = String(Math.max(4, Math.round(result.spectrum.inputRateHz / peak.freqHz))); analyzeSelection() }, peakList)
 }
 view.button('Analyze selection', analyzeSelection)
 spectrum.addEventListener('pointermove', e => { if (!lastSpectrum?.ok) return; const f = Math.max(0, Math.min(1, (e.clientX - spectrum.getBoundingClientRect().left) / spectrum.getBoundingClientRect().width)) * lastSpectrum.nyquistHz; spectrumReadout.textContent = `${f.toPrecision(6)} Hz · period ${f ? (1 / f).toPrecision(6) : '∞'} s` }, { signal: host.signal })
 spectrum.addEventListener('click', e => { if (!lastSpectrum?.ok) return; const f = (e.clientX - spectrum.getBoundingClientRect().left) / spectrum.getBoundingClientRect().width * lastSpectrum.nyquistHz; const peak = lastSpectrum.peaks.reduce((best, p) => !best || Math.abs(p.freqHz - f) < Math.abs(best.freqHz - f) ? p : best, null); if (peak) { period.value = String(Math.max(4, Math.round(lastSpectrum.inputRateHz / peak.freqHz))); analyzeSelection() } }, { signal: host.signal })
 view.button('Save capture in browser storage', () => service.saveCapture())
 const saved = view.select('Saved / interrupted capture', [])
 async function refresh() { saved.replaceChildren(); for (const row of await service.captures()) { const option = view.make('option', `${row.name} · ${row.state} · ${row.samples} samples · ${row.evicted} rolled`, saved); option.value = row.id } }
 view.button('List saved captures', refresh)
 view.button('Load saved capture', async () => { await service.loadCapture(saved.value || undefined); follow.value = 'follow'; render() })
 view.button('Delete saved capture', async () => { await service.removeCapture(saved.value); await refresh() })
 const csvOffset = view.input('CSV segment start sample', '0', 'number'), csvLimit = view.input('CSV segment samples (max 200000)', '200000', 'number')
 view.make('p', 'Large journals export in segments of at most 200000 samples to bound memory. Advance start sample by the segment size to export the next part.')
 view.button('Export saved capture CSV segment', async () => view.download(await service.exportCaptureCSV(saved.value || undefined, { offset: Number(csvOffset.value), limit: Number(csvLimit.value) }), `power-capture-${csvOffset.value}.csv`, 'text/csv'))
 view.button('Export RAM preview CSV', async () => view.download(await service.exportCaptureCSV(), 'power-preview.csv', 'text/csv'))
 view.button('Export capture JSON', () => view.download(JSON.stringify(service.store.export()), 'power-capture.json', 'application/json'))
 const csv = view.input('Import legacy / DeviceDock capture CSV', '', 'file'); csv.accept = '.csv,.tsv'
 csv.addEventListener('change', () => view.run(async () => { const f = csv.files?.[0]; if (!f || f.size > 100_000_000) throw Error('Select CSV under 100 MB'); await service.importCSV(await f.text()); follow.value = 'follow'; render(); view.status.textContent = 'CSV timestamps, current and voltage loaded' }), { signal: host.signal })
 const file = view.input('Import capture JSON', '', 'file'); file.accept = '.json'
 file.addEventListener('change', () => view.run(async () => { if (service.status().busy) throw Error('Stop capture first'); const f = file.files[0]; if (!f || f.size > 100_000_000) throw Error('Capture missing or too large'); service.importCapture(JSON.parse(await f.text())); render(); view.status.textContent = 'Offline capture loaded' }), { signal: host.signal })
 let dirty = false
 const off = service.subscribe(state => { dirty = true; view.status.textContent = `${state.archiveError || (state.sampling ? state.trigger : 'Idle')} · ${state.recordMode === 'long' ? state.totalSamples : state.samples} samples · power ${state.power ?? 'unknown'}` })
 const timer = setInterval(() => { if (dirty) { dirty = false; render() } }, 250)
 return async () => { clearInterval(timer); off(); await service.dispose(); offPreflight(); offTools(); offService(); view.dispose() }
}
