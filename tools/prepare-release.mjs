// Prepare reviewable release assets only; publication is an explicit later step.
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
const out = resolve(import.meta.dirname, '../dist'), version = '1.0.0', repo = 'Roomen/DeviceDock-Plugins'
const catalog = JSON.parse(await readFile(out + '/catalog.json')), hashes = []
for (const entry of catalog.packages) {
 const expected = `https://github.com/${repo}/releases/download/v${version}/${entry.artifact}`
 if (entry.version !== version || entry.url !== expected || !/^org\.devicedock\.[a-z]+-1\.0\.0\.json$/.test(entry.artifact)) throw Error('Release identity mismatch')
 const digest = createHash('sha256').update(await readFile(out + '/' + entry.artifact)).digest('hex')
 if (entry.integrity !== 'sha256-' + digest || entry.sha256 !== digest) throw Error('Stale package digest')
 hashes.push(`${digest}  ${entry.artifact}`)
}
for (const file of ['LICENSE', 'NOTICE']) await copyFile(resolve(out, '..', file), out + '/' + file)
for (const file of ['catalog.json', 'LICENSE', 'NOTICE']) hashes.push(`${createHash('sha256').update(await readFile(out + '/' + file)).digest('hex')}  ${file}`)
await writeFile(out + '/SHA256SUMS', hashes.join('\n') + '\n')
await writeFile(out + '/RELEASE.md', `DeviceDock Plugins ${version}\n\nFive independent API 1 extensions: power, firmware, patch, wireless and USB BLE bridge.\n\nCatalog: https://raw.githubusercontent.com/${repo}/main/catalog.json\n\nThe packaged patch provider is built from pinned public HPatchLite v0.4.3 sources. Licenses and provenance are integrity-listed inside the patch bundle. Firmware execute means command sent; no device flash verification is claimed.\n\nInstall sources require explicit user trust. Artifact checksums are in SHA256SUMS.\n`)
console.log(`Prepared ${catalog.packages.length} release bundles, catalog, notices, SHA256SUMS and RELEASE.md; nothing published`)
