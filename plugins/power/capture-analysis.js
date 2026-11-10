import analysis from './analysis.js'
// Integrate each block at its declared rate. Never integrate across missing intervals.
export function analyzeCapture(store, { from = -Infinity, to = Infinity, threshold, capacityMah = 1000, periodSamples = 100, fftOptions = {}, spikeOptions = {}, batteryOptions = {} } = {}) {
 const values = [], rates = new Set(); let integral = 0, gaps = 0, previousTime, uniform = true
 for (const block of store.blocks) {
  let selected = 0
  for (let i = 0; i < block.values.length; i++) {
   const time = block.times[i]
   if (time < from || time > to) continue
   if (previousTime != null && Math.abs(time - previousTime - 1 / block.rateHz) > 0.1 / block.rateHz) uniform = false
   previousTime = time; values.push(block.values[i]); integral += block.values[i] / block.rateHz; selected++
  }
  if (selected) { rates.add(block.rateHz); gaps += block.gaps?.length || 0 }
 }
 const samples = Float64Array.from(values), unit = store.blocks[0]?.unit || '', stats = analysis.basicStats(samples)
 const currentScale = { 'A': 1e6, 'mA': 1e3, 'µA': 1, 'uA': 1, 'nA': 1e-3 }[unit]
 return { unit, stats, integral: { value: integral, unit: unit + '·s', excludesGaps: true }, gaps,
  twoLevel: analysis.twoLevelStats(samples, threshold), spikes: analysis.findSpikes(samples, { ...spikeOptions, thr: threshold }),
  battery: currentScale ? analysis.estimateBatteryLife(stats.avg * currentScale, capacityMah, batteryOptions) : { ok: false, reason: 'Requires current units' },
  spectrum: uniform && rates.size === 1 && !gaps ? analysis.fftAnalysis(samples, [...rates][0], fftOptions) : { ok: false, reason: 'FFT requires a contiguous uniform-rate selection' },
  cycles: uniform && rates.size === 1 && !gaps ? analysis.extractCycles(samples, periodSamples) : { ok: false, reason: 'Cycle overlay requires a contiguous uniform-rate selection' },
 }
}
