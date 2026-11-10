import { mkdir, readdir, readFile, writeFile, cp, rm, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..'), out = join(root, 'dist')
let previousCatalog
try { previousCatalog = JSON.parse(await readFile(join(root, 'catalog.json'))) } catch (e) { if (e.code !== 'ENOENT') throw e; previousCatalog = { packages: [] } }
await rm(out, { recursive: true, force: true }); await mkdir(out)
const packages = [ ['power', 'Power instrument and analysis', 'plugin', ['web', 'desktop']], ['firmware', 'Device firmware and packaging', 'firmware'], ['patch', 'HPatchLite v0.4.3 patch provider', 'firmware'], ['wireless', 'Bluetooth LE / optional native SPP', 'transport'], ['bridge', 'USB BLE bridge and GATT tools', 'plugin', ['web', 'desktop']] ]
const catalog = { schemaVersion: 1, namespace: 'plugin', repository: 'https://github.com/Roomen/DeviceDock-Plugins', packages: [] }
const digest = bytes => 'sha256-' + createHash('sha256').update(bytes).digest('hex')
for (const [name, title, kind, platforms = ['web', 'desktop', 'mobile']] of packages) {
 const id = 'org.devicedock.' + name, directory = join(out, id)
 await mkdir(directory)
 await cp(join(root, 'plugins', name), join(directory, name), { recursive: true })
 if (name === 'patch') await cp(join(root, 'docs/hpatch-provenance.md'), join(directory, 'patch/PROVENANCE.md'))
 await mkdir(join(directory, 'shared'))
 for (const file of ['ui.js', ...(name === 'power' ? ['charts.js'] : []), ...(name === 'wireless' || name === 'bridge' ? ['stream-port.js'] : [])]) await cp(join(root, 'plugins/shared', file), join(directory, 'shared', file))
 for (const file of ['LICENSE', 'NOTICE']) await cp(join(root, file), join(directory, file))
 const integrity = {}, files = {}
 async function walk(base) {
  for (const name of (await readdir(base)).sort()) {
   const path = join(base, name), stat = await lstat(path), key = relative(directory, path).split('\\').join('/')
   if (stat.isSymbolicLink()) throw Error('Symlinks prohibited')
   if (stat.isDirectory()) await walk(path)
   else { const bytes = await readFile(path); files[key] = bytes.toString('base64'); if (!['LICENSE', 'NOTICE'].includes(key)) integrity[key] = digest(bytes) }
  }
 }
 await walk(directory)
 const manifest = { schemaVersion: 1, id, name: title, version: '1.0.0', apiVersion: 1, kind, entry: name + '/index.js', platforms, capabilities: [], integrity, license: name === 'patch' ? 'SEE LICENSE IN patch/licenses' : 'Apache-2.0' }
 await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
 const bundle = JSON.stringify({ manifest, files }) + '\n', artifact = id + '-1.0.0.json'
 await writeFile(join(out, artifact), bundle)
 const prior = previousCatalog.packages.find(p => p.id === id && p.version === manifest.version && p.sha256 === digest(bundle).slice(7))
 const webUrl = prior?.webUrl
 if (webUrl && !new RegExp('^https://raw\\.githubusercontent\\.com/Roomen/DeviceDock-Plugins/[a-f0-9]{40}/web/' + id.replaceAll('.', '\\.') + '-1\\.0\\.0-' + digest(bundle).slice(7) + '\\.json$').test(webUrl)) throw Error('Unsafe or stale web mirror URL')
 catalog.packages.push({ id, version: manifest.version, apiVersion: 1, kind, platforms: manifest.platforms, artifact, integrity: digest(bundle), sha256: digest(bundle).slice(7), url: `https://github.com/Roomen/DeviceDock-Plugins/releases/download/v1.0.0/${artifact}`, manifest, ...(webUrl ? { webUrl } : {}) })
}
await writeFile(join(out, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n')
await writeFile(join(root, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n')
console.log(`Packaged ${packages.length} self-contained extensions; no code executed during packaging`)
