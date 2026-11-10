# Cross-package services (canonical agreement)

Plugin worker owns power/firmware/wireless/bridge; protocol worker owns codecs and settings adapters.

Firmware requires SEK package to register `org.devicedock.sek.firmware.v1`:

```ts
interface FirmwareCodecV1 {
 apiVersion: 1;
 create(): {
  feed(bytes: Uint8Array): Array<{ code: number; bytes: Uint8Array }>;
  reset(): void;
 };
 codes: { queryVersion: number; newVersion: number; downloadRequest: number; downloadResult: number };
 queryVersion(): Uint8Array;
 parseVersion(bytes: Uint8Array): { resultCode: number; version: string };
 notify(version: string, chunkSize: number, totalChunks: number): Uint8Array;
 parseNotify(bytes: Uint8Array): { resultCode: number };
 parseRequest(bytes: Uint8Array): { chunkIndex: number };
 chunk(index: number, data: Uint8Array, version: string): Uint8Array;
 parseResult(bytes: Uint8Array): { downloadStatus: number };
 acknowledge(status: number): Uint8Array;
 execute(): Uint8Array;
}
```

Methods wrap actual legacy PCP algorithms without transport, globals or DOM. Plugin owns host transaction claim, bounded receive queue, deadlines, abort, retransmission and progress. Subscribe BEFORE query; preserve early/back-to-back device requests. Each run creates fresh codec. Whole package including header is transferred, final chunk FF-padded. Transfer success means execute request sent, NOT verified flashed firmware.

Host implements prepareDeactivate(check: () => void|Promise<void>), rejects while work busy before abort/unregister/release; shared update barrier must use same preflight. Session state/generation with system 'closing' and 'closed' notifications, host.resources.requestPort(providerId, options) and host-managed dedicated power session resource; no plugin acquiring Web Serial directly. Native optional services `org.devicedock.native.ble.v1` / `org.devicedock.native.spp.v1` should implement SDK TransportProvider. No bridge capability assumed; bridge may connect two host session handles and claim both.

Power registers `org.devicedock.power.v1`; firmware `org.devicedock.firmware.v1`; bridge `org.devicedock.bridge.v1`. UI and MCP invoke the SAME object methods. These names do not imply host support; optional SDK hooks only used when actually present, gaps reported.

Optional patch package `org.devicedock.patch` registers:

```ts
interface PatchV1 {
 apiVersion: 1;
 createPatch(oldBytes: Uint8Array, newBytes: Uint8Array,
   options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Uint8Array>;
}
```

It uses `host.assets.read(packagePath): Promise<Uint8Array>` and
`host.assets.createWorker(packagePath, options?): Promise<Worker>` from the host
SDK. Both worker script and WASM must be integrity-listed immutable package assets.
The worker entry is self-contained; main thread transfers verified WASM bytes.
Host owns worker/blob revocation on disable; provider terminates each completed or
cancelled worker. Worker script needs Blob worker permission and WASM compilation
in the shell CSP; no remote code, relative worker import or custom-scheme worker
origin is required.

Firmware API additions: `upgradeAutomatic(lane, rawBytes, options)` owns one
session transaction from version query through baseline selection, packaging,
download, optional rejection ACK / compressed retry, and execute. Options include
chunkSize, replyDelayMs, timeoutMs and userDefine. A unique SHA-256 library image
with the exact queried version is required to try diff; the target still verifies
its old CRC. Ambiguity/missing version uses BLANK compression. Only diff failure
statuses 7/8 retry, once. No execute is sent on failure.

Library API is asynchronous: `library({signal}?)` lists metadata;
`readLibrary(id,{signal}?)` returns metadata and `data: Uint8Array`;
`addToLibrary(name,bytes)` / `removeFromLibrary(id)` use the firmware task/cancel
barrier. Limits are 20 entries and 32 MiB total (including individual entry size). Reads update LRU; add/import report removed metadata, and batch import is one atomic transaction. IndexedDB
stores metadata plus Blob together; all eviction/replacement requests share one
readwrite transaction and complete/abort before releasing task ownership. The
host JSON storage holds only an opaque per-source library database identifier.

Explicit MCP tools use queue-level beforeWrite fences, cancellation and generation checks. Firmware upgrades declare timeoutMs 1260000; bridge tools 60000; default short tools 30000. No arbitrary service dispatch is exposed.
