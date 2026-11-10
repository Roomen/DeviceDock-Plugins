# DeviceDock Plugins

Independent Apache-2.0 ESM extensions for DeviceDock API 1. Source: https://github.com/Roomen/DeviceDock-Plugins.
The root catalog targets versioned GitHub release assets; publish source and assets
before using the remote installation route. See [delivery](docs/delivery.md).

```sh
npm test
npm run build
npm run verify
```

No runtime npm dependencies. `npm ci` installs test-only IndexedDB/Chromium helpers.
Node 22+ is required for tooling. Build produces five
self-contained directories and `{manifest, files}` JSON bundles in `dist/`, plus
`dist/catalog.json`. Every module is copied inside its package; there are no
runtime sibling, old-project, symlink or network module dependencies. Manifest
entry is `<plugin>/index.js`; `shared/` is inside the SAME package root.

For local static delivery, run `python3 -m http.server 8789 --directory dist`.
Use the host extension manager's local package import to select a built JSON
bundle, review its identity and explicitly trust/enable it. Adding a source or
installing a package does not execute it. On desktop builds without Service
Worker, the host owner can use its `tools/integrate.mjs install <package-dir>`
to copy a verified package into the app build. Never import mutable source URLs.
Catalog release URLs are planned publication locations; they are not live releases.

| Package | Included behavior |
| --- | --- |
| `org.devicedock.power` | Dedicated host-managed USB instrument session, BLU calibration/voltage/power/acquisition, one UI/MCP queue, generation binding, resync/loss tracking, typed timestamped blocks, bounded retention, JSON export/import, IndexedDB save/load, waveform selection, statistics/events/FFT/battery/cycle analysis. Offline captures use generic units/rates/gaps. |
| `org.devicedock.firmware` | Original package generation, original/compressed/differential package CRC validation, IndexedDB Blob library (20 entries / 32 MiB, LRU and atomic import), automatic exact-base differential selection and rejected-diff ACK/compressed retry, actual SEK codec service based device-requested chunks/retries, progress, cancellation and execute. Compressed/differential creation requires a licensed patch provider. |
| `org.devicedock.patch` | Optional HPatchLite v0.4.3 source-built patch provider, bounded verified WASM/Worker, cancellation/termination, complete component notices. |
| `org.devicedock.wireless` | Web Bluetooth Nordic UART/HM-10 transport in the common connection selector; serial 20-byte write chunks, copied RX, disconnect and late-open cleanup. Optional shell BLE/SPP providers are registered only when actually available. |
| `org.devicedock.bridge` | Original USB BLE bridge NDJSON protocol/controller: scan/filter, reset-ready boundary, connect/disconnect, pair/passkey, GATT discovery/read/write/notify, duplicate-UUID-safe profiles and profile transport in common connection selector. Not a generic port relay. |

Power and advanced USB bridge target web/desktop. Firmware, patch and wireless
transport also declare mobile; host platform checks reject unsupported packages.
Declared platforms are enforced by the host; physical-device tests are outside this acceptance scope.

Business APIs are `org.devicedock.power.v1`, `org.devicedock.firmware.v1` and
`org.devicedock.bridge.v1`; UI invokes the same objects available to MCP adapters.
Firmware requires `org.devicedock.sek.firmware.v1` from the SEK package. See
[service agreement](docs/service-requirements.md). No MCP server is bundled.

Lifecycle uses `prepareDeactivate` to reject stopping busy acquisition, firmware,
bridge scans/operations or live wireless sessions. Stop/cancel/disconnect first;
then cleanup waits for actual operations and owned resources. Power recognizes
host `closing`/`closed` system records, retaining claims through physical drain
and clearing stale capture without requiring data from a new connection.

## Migration and acceptance

The concrete [migration checklist](docs/migration-checklist.md) maps actual old
functions to implementations and verification. Physical devices are outside the
current acceptance scope. Native BLE/SPP capabilities require a host driver;
unsupported services are shown as unavailable. Source-scoped settings and stores
cannot directly read another application's origin; import exported CSV, JSON or
raw firmware explicitly. No login data is migrated.

The optional `org.devicedock.patch` package registers
`org.devicedock.firmware.patch.v1.createPatch(oldBytes,newBytes,{signal})`.
Enable it for compressed/differential generation and automatic upgrades. It uses
pinned HPatchLite v0.4.3, with a reproducible source wrapper/build and full notices;
see [provenance and validation](docs/hpatch-provenance.md). Its host must implement
`assets.read` and `assets.createWorker`. Firmware library methods are asynchronous;
`library()` returns metadata, `readLibrary(id)` reads bytes, `addToLibrary` and
`removeFromLibrary` commit one IndexedDB transaction. Blob and metadata share a
single record so interrupted replacements cannot leave orphan binary records.
Automatic upgrades select a baseline only when the queried device version has
one distinct library image (SHA-256 identity); device CRC validation is the final
check that it matches the installed build. Only device rejection codes 7/8 cause
one compressed retry. Never execute after a failed download. Manual original
and prebuilt compressed/differential upgrades remain available. Encrypted and
unknown package formats are rejected explicitly.

Power keeps a bounded two-million-sample RAM preview and optional atomic disk
journals with explicit rolling/stop policy, backpressure and error/disconnect
states. Large CSV exports use bounded segments; loading an archive previews its
retained RAM tail. Acquisition/display triggers, pretrigger, long statistics,
waveform selection/pan/zoom, minimap/fullscreen, raw bytes, live serial event lanes,
FFT/cycle/distribution/spike/battery analysis and legacy CSV replay are available.
IndexedDB typed blocks replace the old OPFS compression backend. Analysis excludes
missing time intervals and rejects nonuniform FFT/cycle selections.

License and modified-source attribution are in LICENSE and NOTICE. Third-party
bootstrap/xterm assets, private captures, endpoints, login and updater keys
are not copied. Patch engine/runtime notices are included in its package.

## Optional cross-repository verification

```sh
DEVICEDOCK_TEST_HOST=../DeviceDock DEVICEDOCK_TEST_PROTOCOLS=../DeviceDock-Protocols node tools/integration.mjs
DEVICEDOCK_TEST_HOST=../DeviceDock DEVICEDOCK_TEST_PROTOCOLS=../DeviceDock-Protocols \
 DEVICEDOCK_TEST_HPATCHI=/path/to/pinned-native-hpatchi node tools/test-browser.mjs
```

Browser tests use a temporary headless Chrome profile, no screenshots or hardware.
Set `DEVICEDOCK_TEST_CHROME` for another Chrome executable. Native decoder must be
built from pinned v0.4.3 sources; never use untrusted downloaded binaries. Optional
`DEVICEDOCK_TEST_LEGACY` points to read-only legacy glue/WASM for fixture comparison.
These sibling paths are test inputs only and are never distributed.
