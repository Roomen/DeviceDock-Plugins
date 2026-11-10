// Constant-space statistics for long recordings; integration counts observed samples only.
export class CaptureStatistics {
 constructor() { this.n = 0; this.mean = 0; this.m2 = 0; this.sumSq = 0; this.min = Infinity; this.max = -Infinity; this.chargeUC = 0; this.energyUWh = 0; this.knownVoltage = true; this.first = null; this.last = null; this.gaps = 0 }
 append(block) {
  this.gaps += block.gaps?.length || 0
  for (let i = 0; i < block.values.length; i++) {
   const v = block.values[i], delta = v - this.mean
   this.n++; this.mean += delta / this.n; this.m2 += delta * (v - this.mean); this.sumSq += v * v; this.min = Math.min(this.min, v); this.max = Math.max(this.max, v)
   this.chargeUC += v / block.rateHz
   if (Number.isFinite(block.voltageMv)) this.energyUWh += v * block.voltageMv / 1000 / block.rateHz / 3600; else this.knownVoltage = false
   this.first ??= block.times[i]; this.last = block.times[i]
  }
 }
 summary() {
  return { ready: this.n > 0, mode: 'long', retainedSamples: 0, totalSamples: this.n, span: 'all', unit: 'µA', durationSeconds: this.n ? this.last - this.first : 0, gaps: this.gaps, current: { n: this.n, avg: this.mean, min: this.n ? this.min : 0, max: this.n ? this.max : 0, rms: this.n ? Math.sqrt(this.sumSq / this.n) : 0, sigma: this.n ? Math.sqrt(this.m2 / this.n) : 0 }, chargeUC: this.chargeUC, energyUWh: this.knownVoltage && this.n ? this.energyUWh : null, energySource: 'observed_samples' }
 }
}
