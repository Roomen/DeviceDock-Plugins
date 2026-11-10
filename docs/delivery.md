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
