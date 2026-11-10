export function patchFixtures() {
 const seeded = (length, seed) => { let x = seed; return Uint8Array.from({ length }, () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x & 255 }) }
 const base = Uint8Array.from({ length: 65536 }, (_, i) => i & 255), edited = base.slice(); edited[8] = 123; edited[32000] = 1
 const firmware = base.slice(); firmware.set(new TextEncoder().encode('V1.2.3\0'), 0x4004)
 return [
  ['identical', base, base.slice()], ['sparse', base, edited],
  ['insert-delete', base, Uint8Array.from([...base.slice(0, 100), 1, 2, 3, ...base.slice(130)])],
  ['incompressible', seeded(32768, 1234), seeded(33000, 5678)],
  ['tiny', Uint8Array.of(1), Uint8Array.of(2)], ['blank-firmware', new Uint8Array(32).fill(255), firmware],
 ]
}
