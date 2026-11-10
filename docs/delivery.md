# Initial source delivery

Public repository: https://github.com/Roomen/DeviceDock-Plugins

Default branch: `main`. Catalog: https://raw.githubusercontent.com/Roomen/DeviceDock-Plugins/main/catalog.json

Version `1.0.0` catalog entries point to `https://github.com/Roomen/DeviceDock-Plugins/releases/download/v1.0.0/<id>-1.0.0.json`. These routes become usable only after the reviewed release assets exist. Never overwrite an already published version with changed payloads.

After tests and `npm run build && npm run verify`, run `npm run prepare:release`. This validates package identity/digests and prepares five bundles, catalog, SHA256SUMS, LICENSE, NOTICE and RELEASE.md in ignored `dist/`. It performs no publication. The source tree contains the root catalog; package bundles are release assets.

Initial publication checklist:

1. Recheck remote absence/emptiness; preserve any unrelated content. Audit all reachable public commits and distributable bytes. Preserve public upstream licenses and author contributions.
2. Push the reviewed clean initial `main` snapshot without private unpublished ancestors. No force push. Keep original local feature history.
3. At the coordinator's release gate, create the `v1.0.0` release targeting the exact accepted main commit and upload the five bundle JSON files plus catalog.json, SHA256SUMS, LICENSE and NOTICE. Use RELEASE.md as the release body.
4. Download every catalog URL and verify exact SHA-256. Test installation through the real host remote-source flow with explicit source trust. A sibling-directory integration test alone does not validate this route.

No screenshots, private fixtures, build logs, device captures or intermediate native binaries are release assets. Pinned public HPatch source identity, recipes, authorship and notices remain in source and package assets.

## Browser delivery mirrors

The canonical `url` continues to identify the immutable GitHub release asset for native clients. Browsers use optional `webUrl`: raw.githubusercontent.com at a full immutable commit, with a digest-addressed filename under `web/`. Both routes serve identical bundle JSON bytes and the same catalog SHA-256; package verification and explicit source trust still apply. This avoids the release-download route's missing browser CORS headers without a proxy or verification bypass.

`npm run prepare:release` now also creates exact-byte digest-addressed mirrors from verified bundles. Existing mirrors are never overwritten or removed. First commit the new mirror files, then run `npm run prepare:release -- --web-commit <full-mirror-commit>`. The script reads those committed blobs and requires exact byte identity before adding pinned webUrl fields to the live root catalog. Commit that metadata separately and push normally. The packager preserves existing webUrl only when id/version/digest and safe immutable URL match, so rebuilding cannot silently drop a valid mirror pin or reuse one for different bytes.

Live root catalog metadata can gain webUrl after release. The original release's catalog.json, bundles, checksums and version remain immutable historical assets; do not upload or overwrite them when only browser delivery metadata changes. A future changed runtime bundle requires a new version and new digest-addressed mirror; retain older mirrors for existing catalogs.
