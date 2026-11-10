import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join, posix } from 'node:path'
const root = resolve(import.meta.dirname, '../dist')
const hash = bytes => 'sha256-' + createHash('sha256').update(bytes).digest('hex')
const catalog = JSON.parse(await readFile(join(root, 'catalog.json')))
for (const entry of catalog.packages) {
 const bytes = await readFile(join(root, entry.artifact)); if (hash(bytes) !== entry.integrity) throw Error('Catalog mismatch')
 const { manifest, files } = JSON.parse(bytes)
 if (manifest.id !== entry.id || manifest.apiVersion !== 1 || !files[manifest.entry]) throw Error('Invalid manifest')
 for (const [name, base64] of Object.entries(files)) {
  if (name.startsWith('/') || name.split('/').some(p => p === '..' || p === '.') || !/^[\w./-]+$/.test(name)) throw Error('Unsafe path')
  const data = Buffer.from(base64, 'base64')
  if (!['LICENSE', 'NOTICE'].includes(name) && hash(data) !== manifest.integrity[name]) throw Error('Integrity mismatch ' + name)
  if (name.endsWith('.js')) {
   const source = data.toString()
   for (const match of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
    const path = match[1]; if (!path.startsWith('./') && !path.startsWith('../')) throw Error('External import')
    const target = posix.normalize(posix.join(posix.dirname(name), path)); if (!files[target]) throw Error('Missing module ' + target)
   }
   if (/window\.|bluApi|document\.getElementById/.test(source)) throw Error('Legacy global dependency ' + name)
  }
 }
 for (const name of Object.keys(manifest.integrity)) if (!files[name]) throw Error('Missing asset')
 await import(new URL('../dist/' + entry.id + '/' + manifest.entry, import.meta.url))
}
console.log(`Verified ${catalog.packages.length} package hashes, closed ESM graphs and pure entry imports`)
