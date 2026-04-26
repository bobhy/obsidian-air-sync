# Air Sync -- Architecture

## Vision

Sync should be invisible -- like air. When the user opens Obsidian, changes since the last session are reflected within hundreds of milliseconds. After editing, background sync runs on a 5-second batch interval. Opening a note always shows the latest version. If the network drops or the app crashes, the worst case is a duplicate file; user data is never lost. Conflicts are resolved transparently via auto-merge, and the user is only prompted when edits truly contradict each other.

## Design principles

1. **3-state sync** -- Compare local, remote, and last-sync-record to detect changes. Text conflicts use 3-way merge.
2. **Swappable backends** -- All remote I/O goes through `IFileSystem` + `IBackendProvider`. Adding a backend requires no changes outside `fs/`.
3. **Delta-first** -- Only process files that changed. O(n) full scans are allowed only on cold start.
4. **Pipeline as data** -- Each sync phase is a pure transformation: `ChangeSet → SyncPlan → Result`. I/O is isolated at boundaries; all intermediate states are testable.
5. **Crash-safe by construction** -- State is updated only *after* an action succeeds (per-action commit). An interrupted sync converges by simply re-syncing.
6. **Duplicate over delete** -- When in doubt, keep the file. Deleting an unwanted copy is easy; recovering a lost file is impossible.
7. **Single responsibility per module** -- Each file owns one concept. Target 200-300 lines; split when exceeded.

## File structure

```shell
src/
├── main.ts                          # Plugin entry point (lifecycle only)
├── settings.ts                      # AirSyncSettings type & defaults
├── constants.ts                     # Shared constants (AIRSYNC_DIR)
├── sync/
│   ├── types.ts                     # SyncRecord, MixedEntity, SyncAction, SyncPlan, ConflictRecord, RenamePair
│   ├── local-tracker.ts             # LocalChangeTracker — dirty path set + rename/folder-rename pair tracking
│   ├── change-compare.ts            # hasChanged(), hasRemoteChanged() — diff against baseline
│   ├── change-detector.ts           # collectChanges() — hot/warm/cold temperature modes
│   ├── decision-engine.ts           # planSync() — builds SyncPlan from MixedEntity[]
│   ├── plan-executor.ts             # executePlan() — grouped execution (A/B/C/D)
│   ├── state-committer.ts           # commitAction() — per-action SyncRecord upsert/delete
│   ├── conflict-resolver.ts         # resolveConflict() — 3-strategy conflict resolver
│   ├── rename-optimizer.ts          # refinePlan() — folder + file rename optimization orchestrator
│   ├── rename-optimizer-types.ts    # RenameOptResult, SkippedRename — optimization result types
│   ├── optimize-local-renames.ts    # Local rename optimization (hash-verified)
│   ├── optimize-remote-renames.ts   # Remote rename optimization (trusted)
│   ├── conflict.ts                  # resolveWithStrategy() — low-level strategy implementations
│   ├── merge.ts                     # threeWayMerge() — git-style merge via diffIndices
│   ├── orchestrator.ts              # SyncOrchestrator — retry loop, mutex, status transitions
│   ├── scheduler.ts                 # SyncScheduler — vault events, timers, file-open priority sync
│   ├── state.ts                     # SyncStateStore — IndexedDB persistence for SyncRecords
│   ├── error.ts                     # getErrorInfo(), isRateLimitError(), sleep()
│   ├── signature.ts                 # computeSignature(), readRemoteSignature(), writeRemoteSignature() — session sync guard
│   ├── conflict-history.ts          # ConflictHistory — JSON audit log per device
│   └── remote-vault.ts              # RemoteVaultResolution type, REMOTE_VAULT_ROOT constant
│
├── fs/
│   ├── types.ts                     # FileEntity
│   ├── interface.ts                 # IFileSystem — abstract filesystem contract
│   ├── auth.ts                      # IAuthProvider — OAuth/credential lifecycle
│   ├── backend.ts                   # IBackendProvider — backend provider abstraction
│   ├── registry.ts                  # Backend registry (initRegistry, getBackendProvider)
│   ├── errors.ts                    # AuthError
│   ├── backend-manager.ts           # BackendManager — init, connect, disconnect lifecycle
│   ├── secret-store.ts              # ISecretStore — Obsidian SecretStorage wrapper
│   ├── token-store.ts               # Token read/write/clear helpers for SecretStorage
│   ├── local/
│   │   └── index.ts                 # LocalFs — Vault API with raw adapter fallback for dot-prefixed paths
│   ├── googledrive/
│   │   ├── index.ts                 # GoogleDriveFs — IFileSystem with metadata cache
│   │   ├── client.ts                # DriveClient — Drive REST API v3 client
│   │   ├── auth.ts                  # GoogleAuth (server), GoogleAuthDirect (PKCE)
│   │   ├── metadata-cache.ts        # DriveMetadataCache — path<->ID mapping
│   │   ├── incremental-sync.ts      # applyIncrementalChanges() — changes.list integration
│   │   ├── resumable-upload.ts      # ResumableUploader — large file upload (>5 MB)
│   │   ├── remote-vault.ts          # resolveGDriveRemoteVault() — vault folder resolution + duplicate detection
│   │   ├── provider-base.ts         # GoogleDriveProviderBase, GoogleDriveAuthProviderBase
│   │   ├── provider.ts              # GoogleDriveProvider (built-in OAuth)
│   │   ├── provider-custom.ts       # GoogleDriveCustomProvider (user-provided credentials)
│   │   └── types.ts                 # DriveFile, DriveFileList, DriveChangeList, assertions
│   └── mock/
│       └── index.ts                 # InMemoryFs — test double
│
├── ui/
│   ├── settings.ts                  # AirSyncSettingTab — main settings UI
│   ├── backend-settings.ts          # Backend connection settings section
│   ├── googledrive-settings.ts      # Google Drive specific settings
│   ├── join-conflict-modal.ts       # JoinConflictModal — prompt when local and remote both have unsynced content
│   ├── destructive-sync-modal.ts    # DestructiveSyncModal — confirm when delete/overwrite ratio exceeds threshold
│   └── duplicate-vault-modal.ts     # DuplicateVaultModal — prompt when multiple remote vault folders found
│
├── store/
│   ├── idb-helper.ts                # IDBHelper — IndexedDB transaction wrapper
│   ├── instance-store.ts            # InstanceStore — per-device settings (not synced)
│   ├── metadata-store.ts            # MetadataStore<T> — generic IDB-backed file metadata cache
│   └── client-id.ts                 # resolveClientId() — stable per-vault client identifier
│
├── logging/
│   └── logger.ts                    # Logger — structured log writer (.airsync/logs/)
│
├── queue/
│   └── async-queue.ts               # AsyncPool (bounded concurrency), AsyncMutex
│
└── utils/
    ├── hash.ts                      # sha256() — Web Crypto wrapper
    ├── md5.ts                       # md5() — js-md5 wrapper for cold start hash matching
    ├── path.ts                      # Path utilities (getFileExtension, etc.)
    └── ignore.ts                    # isIgnored() — gitignore-style pattern matching
```

## Layer architecture

```shell
┌──────────────────────────────────────────────────────┐
│  main.ts                                             │
│  Plugin lifecycle: load settings, register commands, │
│  wire up components, handle OAuth protocol callback  │
└────────────┬──────────────────────┬──────────────────┘
             │                      │
     ┌───────▼───────┐    ┌────────▼─────────┐
     │ SyncScheduler │    │  BackendManager   │
     │ vault events, │    │  auth flow,       │
     │ timers,       │    │  remote vault     │
     │ file-open     │    │  resolution,      │
     │ priority sync │    │  IFileSystem init  │
     └───────┬───────┘    └────────┬─────────┘
             │                      │
     ┌───────▼──────────────────────▼──────┐
     │         SyncOrchestrator            │
     │  mutex, retry loop (3x + backoff), │
     │  status transitions, pullSingle     │
     └───────────────┬────────────────────┘
                     │
     ┌───────────────▼────────────────────┐
     │            Pipeline                │
     │                                    │
     │  [startup, once] sig check         │  signature.ts
     │    readRemoteSignature()           │    mismatch → stateStore.clear()
     │        │                           │
     │        ▼                           │
     │  collectChanges()                  │  ChangeDetector
     │    collect (hot / warm / cold)     │    temperature modes
     │    enrichHashesForInitialMatch()   │    MD5 vs contentChecksum
     │        │                           │
     │        ▼                           │
     │  planSync()                        │  DecisionEngine
     │        │                           │    9 action types
     │        ▼                           │
     │  [destructive guard]               │  Orchestrator
     │    confirmDestructiveSync()        │    delete+overwrite ratio check
     │        │                           │
     │        ▼                           │
     │  refinePlan()                      │  RenameOptimizer
     │    coalesceLocal/RemoteFolderRenames│   → rename_remote (hash-verified)
     │    optimizeLocal/RemoteFileRenames │    → rename_local  (trusted)
     │        │                           │
     │        ▼                           │
     │  executePlan()                     │  PlanExecutor
     │    Group A: push/pull/match/cleanup│    AsyncPool(5)
     │    Group B: rename_*/delete_remote │    serial
     │    Group C: delete_local           │    serial
     │    Group D: conflict               │    serial
     │        │                           │
     │        ▼                           │
     │  commitAction()  (per action)      │  StateCommitter
     │        │                           │
     │        ▼                           │
     │  [on full success] write sig       │  signature.ts
     │    writeRemoteSignature()          │
     │    saveLocalSignature()            │
     └───────────────┬────────────────────┘
                     │
         ┌───────────▼───────────┐
         │      IFileSystem      │
         │  LocalFs │ GoogleDriveFs │
         └───────────────────────┘
```

## Core data models

### FileEntity (fs/types.ts)

```typescript
interface FileEntity {
  path: string;          // relative path from sync root
  isDirectory: boolean;
  size: number;          // bytes (0 for directories)
  mtime: number;         // Unix epoch ms (0 = unknown)
  hash: string;          // SHA-256 hex ("" = not computed)
  backendMeta?: Record<string, unknown>;  // e.g. { driveId, contentChecksum }
}
```

### SyncRecord (sync/types.ts)

The baseline snapshot stored per path after each successful sync.

```typescript
interface SyncRecord {
  path: string;            // primary key
  hash: string;            // content hash at last sync
  localMtime: number;      // local mtime at last sync
  remoteMtime: number;     // remote mtime at last sync
  localSize: number;
  remoteSize: number;
  backendMeta?: Record<string, unknown>;
  syncedAt: number;        // when this sync completed
}
```

### MixedEntity (sync/types.ts)

Combined view of a path across local, remote, and baseline state. Input to the decision engine.

```typescript
interface MixedEntity {
  path: string;
  local?: FileEntity;
  remote?: FileEntity;
  prevSync?: SyncRecord;
}
```

### SyncAction / SyncPlan (sync/types.ts)

```typescript
type SyncActionType =
  | "push" | "pull"
  | "delete_local" | "delete_remote"
  | "rename_remote" | "rename_local"
  | "conflict" | "match" | "cleanup";

type SyncAction = StandardSyncAction | RenameAction;

interface StandardSyncAction {
  path: string;
  action: Exclude<SyncActionType, "rename_remote" | "rename_local">;
  local?: FileEntity;
  remote?: FileEntity;
  baseline?: SyncRecord;
}

interface RenameAction {
  path: string;
  action: "rename_remote" | "rename_local";
  oldPath: string;
  isFolder?: boolean;        // true for folder renames; descendants lists affected children
  descendants?: RenamePair[];
  local?: FileEntity;
  remote?: FileEntity;
  baseline?: SyncRecord;
}

interface SyncPlan {
  actions: SyncAction[];
}
```

### Additional types (sync/types.ts)

```typescript
/** A rename pair: source and destination paths */
interface RenamePair {
  oldPath: string;
  newPath: string;
  isFolder?: boolean;
}

/** User-facing strategy for resolving conflicts */
type ConflictStrategy = "auto_merge" | "duplicate" | "ask";

/** Audit record written to ConflictHistory after a conflict is resolved */
interface ConflictRecord {
  path: string;
  actionType: SyncActionType;
  strategy: ConflictStrategy;
  action: "kept_local" | "kept_remote" | "duplicated" | "merged";
  local?: FileEntity;
  remote?: FileEntity;
  duplicatePath?: string;
  hasConflictMarkers?: boolean;
  resolvedAt: string;
  sessionId: string;
}
```

## IFileSystem interface

All paths are relative to the sync root, forward-slash separated, no leading/trailing slashes.

```typescript
interface IFileSystem {
  readonly name: string;
  list(): Promise<FileEntity[]>;
  stat(path: string): Promise<FileEntity | null>;
  read(path: string): Promise<ArrayBuffer>;
  write(path: string, content: ArrayBuffer, mtime: number): Promise<FileEntity>;
  mkdir(path: string): Promise<FileEntity>;
  listDir(path: string): Promise<FileEntity[]>;
  delete(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  getChangedPaths?(): Promise<{
    modified: string[];
    deleted: string[];
    renamed?: { oldPath: string; newPath: string }[];
  } | null>;
  close?(): Promise<void>;
}
```

Key design points:

- `list()` may return `hash: ""` for performance; use `stat()` when an accurate hash is needed.
- `getChangedPaths()` is optional. When implemented (e.g. Google Drive changes.list), it enables the hot change-detection path. The `renamed` field allows backends to report file moves for native rename optimization.
- `delete()` is idempotent. Backends may use soft deletion (trash).
- `write()` auto-creates parent directories.

## LocalFs (fs/local/index.ts)

`LocalFs` implements `IFileSystem` backed by the Obsidian `Vault` API. Obsidian excludes dot-prefixed paths (`.templates/`, `.airsync/`, etc.) from its file index, so `LocalFs` applies a two-tier access strategy:

- **Operations** (`stat`, `read`, `write`, `delete`, `rename`, `listDir`): vault API first; if the path is absent from the vault index, fall back to the raw `vault.adapter`. This covers both user-configured dot paths and the internal `.airsync/` directory without an explicit allowlist.
- **Sync enumeration** (`list`): returns all vault-indexed files, then appends files from each directory in `syncDotPaths` (user setting) via `vault.adapter`. The `AIRSYNC_DIR` (`.airsync`) directory is intentionally **excluded** from enumeration — it is internal plugin storage and is never synced unless the user explicitly adds it to *dot-prefixed folders to sync* in settings.

The `write()` path uses `path.startsWith(".")` to route new dot-prefixed files to `vault.adapter.writeBinary()`, since they cannot be created via the vault API.

## IBackendProvider / IAuthProvider

### IBackendProvider (fs/backend.ts)

Abstraction for a remote storage backend. main.ts and sync/ never import backend-specific modules directly.

```typescript
interface IBackendProvider {
  readonly type: string;             // "googledrive", "googledrive-custom"
  readonly displayName: string;
  readonly auth: IAuthProvider;
  createFs(app, settings, logger?): IFileSystem | null;
  isConnected(settings): boolean;
  getSyncTarget(settings): string | null;  // opaque key identifying the remote vault (e.g. Drive folder ID)
  resetTargetState?(settings): void;
  readBackendState?(fs): Record<string, unknown>;
  resolveRemoteVault?(app, settings, vaultName, logger?): Promise<RemoteVaultResolution>;
  disconnect(settings): Promise<Record<string, unknown>>;
}
```

### IAuthProvider (fs/auth.ts)

```typescript
interface IAuthProvider {
  isAuthenticated(backendData): boolean;
  startAuth(backendData): Promise<Record<string, unknown>>;
  completeAuth(input, backendData): Promise<Record<string, unknown>>;
}
```

The provider registry (`fs/registry.ts`) maps backend types to provider instances. New backends register here; no changes needed elsewhere.

## Remote vault folder resolution

`resolveGDriveRemoteVault()` (`fs/googledrive/remote-vault.ts`) is called once per connection
attempt by the backend provider. It locates (or creates) the vault's folder under
`obsidian-air-sync/` in Google Drive and returns its folder ID for use by `GoogleDriveFs`.

**Folder naming:** The folder is named `sanitizeDbName(effectiveName)` where `effectiveName` is
`backendData.remoteVaultFolderName` when the user has set a custom name, or the local vault name
otherwise. This allows two vaults with different local names to share one Drive folder, or a vault
to be renamed locally without abandoning its existing Drive folder.

**Discovery (single path):** The root `obsidian-air-sync/` folder is found or created, then its
children are listed and filtered by folder name:

- 0 matches → a new folder is created with the sanitized vault name.
- 1 match → that folder is used.
- 2+ matches → `DuplicateVaultModal` explains the situation and the connection fails. The user
  must remove the extra folder(s) in Google Drive before retrying.

The resolved folder ID is stored in `backendData.remoteVaultFolder` and used by `GoogleDriveFs`
for all subsequent I/O. `resolveRemoteVault` is called on every connect attempt — there is no
separate fast path for a cached folder ID.

The `RemoteVaultCallbacks` interface decouples the resolution logic from UI: callers provide
`notify` (toast) and `promptDuplicateVaults` (modal) callbacks; tests omit them to get plain
error throws.

## Startup safety: stale sync state

`SyncStateStore` (IndexedDB, keyed by `vaultId`) survives plugin reinstalls because it is stored in
the Obsidian application data directory, not in the plugin folder. `vaultId` itself is persisted in
`InstanceStore` (a separate IDB database), also independent of `settings.json`.

This creates a hazard: if the plugin folder is deleted (reinstall) and the local vault files are
also absent, orphaned sync records would cause warm-mode change detection to classify those files
as *locally deleted* and issue `delete_remote` actions — potentially trashing remote content.

**Guard:** `main.ts` detects a missing `settings.json` on startup (`loadData()` returning null) and
calls `orchestrator.clearSyncState()` before the first sync runs. With no sync records the next sync
is a cold scan, which compares actual file content and can never trigger `delete_remote` without a
prior baseline.

## Detailed documentation

- [Sync pipeline](docs/sync-pipeline.md) -- temperature modes, decision table, execution groups
- [Conflict resolution](docs/conflict-resolution.md) -- strategies, 3-way merge, conflict history
- [Google Drive backend](docs/google-drive-backend.md) -- metadata cache, incremental sync, authentication
- [Error handling](docs/error-handling.md) -- classification, retry, recovery scenarios
- [Multi-device sync](docs/multi-device.md) -- settings split, group join flow, vault disambiguation, disconnect/reconnect
