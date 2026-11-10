# SDK integration baseline

API 1, DeviceDock `sdk/index.d.ts` and `docs/extension-contract.md`, including
clarifications of 2026-11-10: canonical versioned service names, prepareDeactivate,
resources.requestPort(providerId, options), createSession/releaseSession,
Session.state/connected/deviceInfo, and system closing/closed notifications.

Plugin entrypoints use only host.mount.ownerDocument for UI. Serial selection is
host.resources.requestPort('serial', options), including desktop native providers.
No navigator.serial acquisition exists in plugins. Wireless itself implements a
transport provider using the user-selected Web Bluetooth device.

The host must preserve generation-bound claims through physical close/write drain,
emit closed after releasing the old generation, and allow owner-scoped cleanup I/O.
Power does not release a stale capture while state is closing/cleanup-needed. The
host must not unregister the SEK firmware capability while its consumer transaction
is active; firmware pins the capability object per transfer, with no globals.

Optional native BLE/SPP services conform to SDK TransportProvider. They are gated
by actual getService availability. The shell owner must supply permissioned drivers
and shared physical resource arbitration; no cross-repo native code is changed here.

Additive MCP contract: registerMcpTool has bounded timeoutMs (1000–1800000); handlers use cancellation, snapshot generation checks and commit inside the real beforeWrite queue. Owned SessionService.setSignals preserves resource ownership; common lanes cannot be controlled by a plugin. Power and bridge use the dedicated resource signal hook, never raw ports. Native BLE/SPP providers and selection UI are implemented by the current host shell and optional compiled drivers.
