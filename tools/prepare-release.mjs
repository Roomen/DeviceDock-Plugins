// Prepare reviewable release assets only; publication is an explicit later step.
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
const out = resolve(import.meta.dirname, '../dist'), version = '1.0.0', repo = 'Roomen/DeviceDock-Plugins'
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--web-commit' || !/^[a-f0-9]{40}$/.test(args[1]))) throw Error('Use --web-commit <full immutable mirror commit>')
const mirrorCommit = args[1], root = resolve(out, '..'), mirrorDir = resolve(root, 'web')
await mkdir(mirrorDir, { recursive: true })
const previous = JSON.parse(await readFile(root + '/catalog.json'))
const catalog = JSON.parse(await readFile(out + '/catalog.json')), hashes = []
for (const entry of catalog.packages) {
 const expected = `https://github.com/${repo}/releases/download/v${version}/${entry.artifact}`
 if (entry.version !== version || entry.url !== expected || !/^org\.devicedock\.[a-z]+-1\.0\.0\.json$/.test(entry.artifact)) throw Error('Release identity mismatch')
 const digest = createHash('sha256').update(await readFile(out + '/' + entry.artifact)).digest('hex')
 if (entry.integrity !== 'sha256-' + digest || entry.sha256 !== digest) throw Error('Stale package digest')
 const filename = `${entry.id}-${entry.version}-${digest}.json`, bytes = await readFile(out + '/' + entry.artifact), target = resolve(mirrorDir, filename)
 try { const existing = await readFile(target); if (!existing.equals(bytes)) throw Error('Refusing to overwrite immutable mirror') } catch (e) { if (e.code !== 'ENOENT') throw e; await writeFile(target, bytes, { flag: 'wx' }) }
 if (mirrorCommit) {
  const committed = execFileSync('git', ['show', `${mirrorCommit}:web/${filename}`], { cwd: root, maxBuffer: 32 * 1024 * 1024 })
  if (!committed.equals(bytes)) throw Error('Pinned mirror commit does not contain exact release bytes')
  entry.webUrl = `https://raw.githubusercontent.com/${repo}/${mirrorCommit}/web/${filename}`
 } else {
  const prior = previous.packages.find(p => p.id === entry.id && p.version === entry.version && p.sha256 === digest)
  if (prior?.webUrl) {
   const commit = new URL(prior.webUrl).pathname.split('/')[3]
   if (!/^[a-f0-9]{40}$/.test(commit) || prior.webUrl !== `https://raw.githubusercontent.com/${repo}/${commit}/web/${filename}`) throw Error('Unsafe prior web mirror URL')
   entry.webUrl = prior.webUrl
  }
 }
 hashes.push(`${digest}  ${entry.artifact}`)
}
await writeFile(out + '/catalog.json', JSON.stringify(catalog, null, 2) + '\n')
await writeFile(root + '/catalog.json', JSON.stringify(catalog, null, 2) + '\n')
for (const file of ['LICENSE', 'NOTICE']) await copyFile(resolve(out, '..', file), out + '/' + file)
for (const file of ['catalog.json', 'LICENSE', 'NOTICE']) hashes.push(`${createHash('sha256').update(await readFile(out + '/' + file)).digest('hex')}  ${file}`)
await writeFile(out + '/SHA256SUMS', hashes.join('\n') + '\n')
await writeFile(out + '/RELEASE.md', `DeviceDock Plugins ${version}\n\nFive independent API 1 extensions: power, firmware, patch, wireless and USB BLE bridge.\n\nCatalog: https://raw.githubusercontent.com/${repo}/main/catalog.json\n\nThe packaged patch provider is built from pinned public HPatchLite v0.4.3 sources. Licenses and provenance are integrity-listed inside the patch bundle. Firmware execute means command sent; no device flash verification is claimed.\n\nInstall sources require explicit user trust. Artifact checksums are in SHA256SUMS.\n`)
console.log(`Prepared ${catalog.packages.length} release bundles and byte-identical digest-addressed web mirrors; ${catalog.packages.filter(p => p.webUrl).length} commit-pinned web URLs; notices and checksums prepared; nothing published`)
