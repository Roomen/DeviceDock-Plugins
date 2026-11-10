import { BlockStore } from './stream.js'
// Accept legacy timestamp_s,current_uA[,voltage_mV] and DeviceDock segments.
export function parseCaptureCSV(text) {
 if (typeof text !== 'string' || text.length > 100_000_000) throw Error('CSV exceeds 100 MB')
 const rows = text.replace(/^\uFEFF/, '').split(/\r?\n/), data = []; let header = null
 for (const line of rows) {
  if (!line.trim() || line.trim().startsWith('#')) continue
  const cells = line.trim().split(/[,;\t]/).map(s => s.trim())
  if (!header && /timestamp|seconds|current/i.test(cells.join(','))) { header = cells; continue }
  if (cells.length < 2 || cells[0] === '' || cells[1] === '') throw Error('CSV requires timestamp and current')
  const t = Number(cells[0]), value = Number(cells[1]), dock = header?.includes('unit')
  const unit = dock ? cells[header.indexOf('unit')] : 'µA', rate = dock ? Number(cells[header.indexOf('rateHz')]) : null
  const voltageIndex = header?.indexOf('voltage_mV') ?? 2, v = cells[voltageIndex]
  const voltageMv = voltageIndex >= 0 && v !== '' && v != null ? Number(v) : null
  const gaps = dock ? Number(cells[header.indexOf('gapsBeforeBlock')]) || 0 : 0
  if (!Number.isFinite(t) || !Number.isFinite(value) || !['µA', 'uA', 'mA', 'A', 'nA'].includes(unit) || rate != null && (!Number.isFinite(rate) || rate <= 0) || voltageMv != null && (!Number.isFinite(voltageMv) || voltageMv <= 0) || data.length && t <= data.at(-1).t) throw Error('Invalid or unordered CSV sample')
  data.push({ t, value, unit, rate, voltageMv, gaps }); if (data.length > 2_000_000) throw Error('Import at most 2 million samples per CSV segment')
 }
 if (data.length < 2) throw Error('CSV requires at least two samples')
 const deltas = data.slice(1).map((row, i) => row.t - data[i].t).sort((a, b) => a - b), inferredRate = 1 / deltas[Math.floor((deltas.length - 1) / 2)]
 const store = new BlockStore(); let current = [], previous
 function flush() {
  if (!current.length) return
  const first = current[0]
  store.append({ values: Float64Array.from(current, r => r.value), times: Float64Array.from(current, r => r.t), rateHz: first.rate || inferredRate, unit: first.unit, voltageMv: first.voltageMv, gaps: first.gaps ? [{ imported: true, count: first.gaps }] : [] }); current = []
 }
 for (const row of data) {
  if (previous && (row.unit !== previous.unit)) throw Error('CSV units must be consistent')
  if (previous && Math.abs(row.t - previous.t - 1 / (row.rate || inferredRate)) > .1 / (row.rate || inferredRate)) row.gaps ||= 1
  if (current.length >= 4096 || previous && (row.rate !== previous.rate || row.voltageMv !== previous.voltageMv || row.gaps)) flush()
  current.push(row); previous = row
 }
 flush(); return store
}
