# Multi-device sync

## Settings split: synced vs per-device

`AirSyncSettings` is the single in-memory runtime type used throughout the plugin. At persistence boundaries, settings are split into two stores:

### Synced settings (`settings.json` / `saveData`)

Written by `toSyncable()` in `settings.ts`. Contains everything that should be shared across devices in the same sync group: conflict strategy, ignore patterns, sync dot paths, backend type, backend-specific connection data (minus instance fields).

Fields omitted from `settings.json`: `vaultId`, `enableLogging`, `logLevel` (all per-device).

### Per-device settings (`InstanceStore`)

`InstanceStore` (`store/instance-store.ts`) stores per-device state in IndexedDB under the database name `air-sync-instance`. Each vault gets its own record, keyed by `vaultInstanceKey()`.

```typescript
interface InstanceSettings {
  vaultId: string;               // stable ID used as IDB key for SyncStateStore and MetadataStore
  enableLogging: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
  backendInstance: Record<string, { accessTokenExpiry: number }>;
}
```

`accessTokenExpiry` is also per-device (token refresh schedules differ) and is stripped from `settings.json` by `toSyncable()`.

### Bootstrap migration

On first load after upgrading to a version that introduces `InstanceStore`, `instanceData.vaultId` will be empty. `loadSettings()` detects this and migrates the relevant fields from the last-saved `settings.json` so that existing `vaultId` values (and thus `SyncStateStore` / `MetadataStore` caches) are preserved.

## Vault identification (`vaultInstanceKey`)

`InstanceStore` records are keyed by `vaultInstanceKey(vaultName, configDir, basePath?)`. On desktop, `basePath` is the absolute vault filesystem path from `FileSystemAdapter.getBasePath()`. This ensures two vaults with the same name (common in a testing setup) get distinct keys and therefore distinct `vaultId`s, which prevents their `SyncStateStore` databases from colliding.

On mobile, `FileSystemAdapter` does not expose `getBasePath()`; the key falls back to `sanitize(vaultName + "_" + configDir)`. This is acceptable because mobile Obsidian only opens one vault at a time.

**Why this matters for sync correctness:** `SyncStateStore` is keyed by `vaultId`. If two vaults share a `vaultId`, their `prevSync` records are shared. A file pushed by vault B would appear to vault A as "previously synced then locally deleted", causing A to issue a `delete_remote` on the next cycle.

## Group join flow

`BackendManager.handleInitialConnect()` is called after OAuth completes (`completeBackendConnect()`). It routes to one of four cases based on whether the remote vault was just created and what local state exists:

| Case | Condition | Action |
|------|-----------|--------|
| A | `wasCreated = true` | Remote vault just created. Notify user, proceed to first sync. |
| B1 | `wasCreated = false`, `hasSyncHistory() = true` | This device has synced with this group before. Notify "Resuming sync". |
| B2 | `wasCreated = false`, no sync history, local vault empty | Fresh device joining existing group. Download and apply `data.json` from remote (seeds shared settings), then sync. |
| B3 | `wasCreated = false`, no sync history, local vault has content | Conflict: both sides have content that has never been synced. Show `JoinConflictModal`. |

### Case B3: JoinConflictModal

`JoinConflictModal` (`ui/join-conflict-modal.ts`) offers two choices:

- **Cancel**: disconnect the backend and leave the local vault unchanged.
- **Combine vaults**: seed settings from remote (same as B2) and proceed with sync. The first sync cycle runs cold mode (no prevSync records) and will detect all files on both sides. Files unique to one side are pushed/pulled; files present on both sides with identical content match; divergent files conflict.

### Settings seeding (`seedGroupSettings`)

`BackendManager.seedGroupSettings()` downloads `{configDir}/plugins/obsidian-air-sync/data.json` from the remote vault and writes it locally, then calls `reloadSettings()`. This ensures the joining device adopts the group's shared settings (ignore patterns, conflict strategy, sync dot paths) before its first sync.

## Disconnect and reconnect

Disconnecting via settings calls `BackendManager.disconnectBackend()`:

1. Captures the current `getSyncTarget()` value (the remote vault folder key) into `syncTargetBeforeDisconnect`.
2. Calls `provider.disconnect()` to revoke auth and clear `backendData`.
3. **Does not** call `onSyncTargetChanged()` — sync state (`SyncStateStore`) is intentionally preserved. Reconnecting to the same vault will hit Case B1 ("Resuming sync") rather than Case B3 (conflict modal).

On reconnect (`completeBackendConnect()`):

1. After OAuth and `resolveRemoteVault()`, the new `getSyncTarget()` is compared against `syncTargetBeforeDisconnect`.
2. If they differ (user switched to a different Google account or vault folder), `onSyncTargetChanged()` is called to clear stale sync records before the first sync.
3. If they match, sync state is intact and the next cycle runs warm mode.
