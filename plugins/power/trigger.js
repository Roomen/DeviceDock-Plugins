// Acquisition gate, independent of transport and display. Unknown level only seeds.
export class EdgeDetector {
 constructor(mode, level, hysteresis = 0) { this.mode = mode; this.level = level; this.hysteresis = hysteresis; this.state = 0 }
 push(value) {
  const next = value >= this.level + this.hysteresis ? 1 : value <= this.level - this.hysteresis ? -1 : this.state
  const edge = this.state && next !== this.state ? next === 1 ? 'rise' : 'fall' : null
  this.state = next
  return !!edge && (this.mode === 'either' || edge === this.mode)
 }
}
export class CaptureGate {
 constructor({ start = 'off', stop = 'off', level = 100, hysteresis = 1, preSamples = 0, durationSeconds = 0, autoLevel = false, warmupSamples = 0 } = {}) {
  if (typeof autoLevel !== 'boolean' || !Number.isInteger(warmupSamples) || warmupSamples < 0 || warmupSamples > 5000) throw Error('Invalid trigger warmup')
  if (![start, stop].every(m => ['off', 'rise', 'fall', 'either'].includes(m)) || !Number.isFinite(level) || !Number.isFinite(hysteresis) || hysteresis < 0 || !Number.isInteger(preSamples) || preSamples < 0 || preSamples > 2_000_000 || !Number.isFinite(durationSeconds) || durationSeconds < 0) throw Error('Invalid acquisition trigger')
  this.autoLevel = autoLevel; this.warmup = warmupSamples; this.min = Infinity; this.max = -Infinity; this.recent = []; this.recentCursor = 0
  this.start = new EdgeDetector(start, level, hysteresis); this.stop = new EdgeDetector(stop, level, hysteresis)
  this.preSamples = preSamples; this.pre = new Array(preSamples); this.count = 0; this.cursor = 0; this.duration = durationSeconds
  this.phase = start === 'off' ? 'recording' : 'armed'; this.triggerTime = null; this.firstTime = null
 }
 push(value, time) {
  if (this.phase === 'stopped') return []
  if (this.autoLevel) {
   if (this.phase === 'armed') { this.min = Math.min(this.min, value); this.max = Math.max(this.max, value) }
   else { this.recent[this.recentCursor++ % 2000] = value; if (this.recent.length >= 8 && this.recentCursor % 64 === 8) { this.min = Math.min(...this.recent); this.max = Math.max(...this.recent) } }
   const level = this.max > this.min ? (this.max + this.min) / 2 : value, hysteresis = Math.max((this.max - this.min) * .05, Math.abs(level) * .02, 1e-6)
   this.start.level = this.stop.level = level; this.start.hysteresis = this.stop.hysteresis = hysteresis
  }
  if (this.warmup > 0) { this.warmup--; if (this.phase === 'armed') this.start.push(value); return [] }
  if (this.phase === 'armed') {
   if (!this.start.push(value)) {
    if (this.preSamples) { this.pre[this.cursor] = [value, time]; this.cursor = (this.cursor + 1) % this.preSamples; this.count = Math.min(this.count + 1, this.preSamples) }
    return []
   }
   this.phase = 'recording'; this.triggerTime = time; this.firstTime = time
   const output = []
   for (let i = 0; i < this.count; i++) output.push(this.pre[(this.cursor - this.count + i + this.preSamples) % this.preSamples])
   this.pre = []; this.stop.push(value); output.push([value, time]); return output
  }
  this.firstTime ??= time
  const stop = this.stop.push(value) || (this.duration > 0 && time - this.firstTime >= this.duration)
  if (stop) this.phase = 'stopped'
  return [[value, time]]
 }
}
