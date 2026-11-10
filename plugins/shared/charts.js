// Canvas charts use bounded min/max envelopes, preserving spikes at screen resolution.
export function plot(canvas, input, { log = false, color = '#178872', overlay = false, domain } = {}) {
 const values = input?.values && !Array.isArray(input) && !ArrayBuffer.isView(input) ? input.values : input, times = input?.times, breaks = new Set(input?.breaks || [])
 const ctx = canvas.getContext('2d'); if (!ctx) return
 const w = canvas.width, h = canvas.height, transform = log ? v => Math.sign(v) * Math.log10(1 + Math.abs(v)) : v => v
 if (!overlay) ctx.clearRect(0, 0, w, h)
 if (!values?.length) return
 let min = Infinity, max = -Infinity
 for (const value of values) { const v = transform(value); min = Math.min(min, v); max = Math.max(max, v) }
 if (domain) { min = transform(domain[0]); max = transform(domain[1]) }
 const y = v => h - 20 - (transform(v) - min) / (max - min || 1) * (h - 40)
 ctx.strokeStyle = color; ctx.beginPath()
 const xAt = i => times ? (times[i] - times[0]) / (times.at(-1) - times[0] || 1) * w : i / Math.max(1, values.length - 1) * w
 const stride = Math.max(1, Math.ceil(values.length / w))
 for (let i = 0; i < values.length; i += stride) {
  let lo = Infinity, hi = -Infinity
  for (let j = i; j < Math.min(values.length, i + stride); j++) { lo = Math.min(lo, values[j]); hi = Math.max(hi, values[j]) }
  const x = xAt(i)
  ctx.moveTo(x, y(lo)); ctx.lineTo(x, y(hi)); if (stride === 1 && i && !breaks.has(i)) { ctx.moveTo(xAt(i - 1), y(values[i - 1])); ctx.lineTo(x, y(lo)) }
 }
 ctx.stroke(); if (times?.length) ctx.fillText(`${times[0].toPrecision(5)} – ${times.at(-1).toPrecision(5)} s`, 8, h - 2); ctx.fillStyle = '#737373'; ctx.fillText(`${max.toPrecision(5)} / ${min.toPrecision(5)}${log ? ' (signed log)' : ''}`, 8, 12)
}
