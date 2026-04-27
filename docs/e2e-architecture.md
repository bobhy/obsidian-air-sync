# E2E test architecture

The E2E suite exercises the plugin against live Obsidian desktop instances and real Google Drive. No mocking — every sync cycle runs the full stack.

## Test types

| Command | Config | What it runs |
|---|---|---|
| `npm run test:e2e:single` | `wdio.conf.mts` | Single-vault tests in `tests/wdio/single/` |
| `npm run test:e2e:cross` | `wdio.multiremote.conf.mts` | Cross-vault tests in `tests/wdio/cross/` using two simultaneous Obsidian instances |

Both commands run `npm run build` first so tests always exercise the latest code.

## One-time setup

```bash
npm run setup:e2e:wdio
```

This is interactive. It opens a browser for the Google Drive OAuth flow and saves the resulting refresh token to `.e2e-refresh-token`. Subsequent runs read the token from that file automatically; you do not need to redo the OAuth flow unless the token expires or is revoked.

Alternatively, set `AIRSYNC_REFRESH_TOKEN` in the environment to skip the file.

## Directory layout

```text
tests/wdio/
  single/                    — single-vault test files (*.e2e.ts)
  cross/                     — cross-vault test files (*.e2e.ts)
  helpers/
    gdrive.ts                — Drive REST API helpers (token management, file polling, cleanup)
  setup-wdio-token.ts        — interactive OAuth setup script (npm run setup:e2e:wdio)
tests/vaults/
  primary/                   — source vault copied to a temp dir for each run
  peer/                      — source vault copied to a temp dir for each run (cross only)
wdio.conf.mts                — single-vault wdio config
wdio.multiremote.conf.mts    — cross-vault wdio config
```

## How a test run works

### Single-vault mode

`wdio-obsidian-service` handles vault setup automatically:

1. Copies `tests/vaults/primary/` to a temp directory
2. Installs the built plugin into it
3. Launches Obsidian with a fresh `--user-data-dir`
4. The `before` hook in `wdio.conf.mts` injects the refresh token into the vault's SecretStorage and calls `initBackend()` directly on the loaded plugin

### Cross-vault mode (multiremote)

`wdio-obsidian-service` does not handle multiremote capabilities automatically, so `wdio.multiremote.conf.mts` replicates the two steps in its `beforeSession` hook:

1. Calls `launcher.setupVault()` for each capability — copies the vault to a temp dir and installs plugins
2. Calls `launcher.setupConfigDir()` to write `obsidian.json` and get a `--user-data-dir` path
3. Injects `--user-data-dir` into each capability's `goog:chromeOptions`

Two Obsidian processes then start in parallel. The `before` hook in `wdio.multiremote.conf.mts` ensures the refresh token is in `process.env` for the Drive helpers.

The test file's own `before()` hook handles vault-level initialization (token injection + `initBackend()`) because `executeObsidian` is not registered on multiremote instances.

### Token injection pattern

Both modes must inject the OAuth refresh token into the vault after Obsidian starts because each run uses a fresh `--user-data-dir` (SecretStorage is empty). The test file's `before()` injects the token and calls `initBackend()` directly on the plugin, then polls until `getRemoteFs()` returns a truthy value.

### `execVault` — running code inside Obsidian

In multiremote mode, `executeObsidian` is not available on instances returned by `browser.getInstance()`. Tests use a local `execVault` helper instead, which serializes a function and runs it via `br.execute()` using the same `window.wdioObsidianService()` call-site pattern:

```typescript
function execVault<T>(
    br: WebdriverIO.Browser,
    script: (ctx: VaultCtx, ...args: unknown[]) => T | Promise<T>,
    ...params: unknown[]
): Promise<T>
```

## Test isolation

Each test generates a unique filename using `Date.now()` (e.g. `e2e-cross-create-1745123456789.md`), so tests never collide with each other even within a run.

**Local vaults** are fresh for every run — `beforeSession` copies the source vault to a temp directory. After each test, `afterEach` deletes any `e2e-cross-*` and `sync-trigger.md` files from both vault instances.

**Google Drive** is not reset between runs. The suite-level `before()` hook deletes all `e2e-cross-*` files from the Drive vault folder before any test runs, removing stale files left by previous crashed runs. This uses `deleteStaleTestFiles` from the gdrive helper.

Temp vault directories are removed in `onComplete` after all tests finish.

## Triggering sync

Sync runs automatically when the vault emits a file event (create/modify/delete). Tests use a `triggerSync` helper that creates (or recreates) a throwaway `sync-trigger.md` note, which fires `vault.on('create')` and wakes up `debouncedSync()`.

## Conflict test pattern

To create a controlled conflict:

1. Create the base file in primary and let it propagate to peer.
2. Pause sync in both vaults by setting `syncPaused = true` on the plugin instance (accessible via `ctx.app.plugins.plugins["air-sync"] as { syncPaused: boolean }`).
3. Modify the file differently in each vault.
4. Resume primary and trigger its sync. Use `pollForFileContent` to gate on Drive receiving primary's version.
5. Resume peer and trigger its sync. The plugin detects a conflict and performs a 3-way merge, writing `<<<<<<< LOCAL` / `=======` / `>>>>>>> REMOTE` markers.
6. Poll the peer vault for conflict markers, re-triggering sync periodically if Drive lags.
7. Trigger sync in primary to pull the merged content down.

## Diagnostics

Set `WDIO_DEBUG=1` in the environment to enable per-poll diagnostic log lines during Obsidian startup:

```text
[primaryVault] windowApp=true wdioSvc=true svcKeys=[air-sync,...] ...
```

Set `logLevel: "warn"` in both wdio configs to suppress verbose wdio COMMAND/RESULT/DATA lines while preserving the spec reporter output.

## Helpers reference (`tests/wdio/helpers/gdrive.ts`)

All Drive access uses the Drive REST API v3 with `fetch`. Tokens are exchanged via `POST https://auth-smartsync.takezo.dev/google/token/refresh` and cached until 60 s before expiry.

| Function | Purpose |
|---|---|
| `resolveVaultFolder(vaultName)` | Walks `My Drive / obsidian-air-sync / <sanitized-vault-name>` and returns the Drive folder ID |
| `pollForFile(folderId, filename, timeoutMs?)` | Polls every 2 s until the file appears; default timeout 30 s |
| `pollForFileGone(fileId, timeoutMs?)` | Polls every 2 s until the file is deleted or trashed |
| `pollForFileContent(fileId, text, timeoutMs?)` | Polls every 2 s until the file's content contains `text` |
| `deleteFile(fileId)` | Deletes a file by ID (404 is treated as success) |
| `deleteStaleTestFiles(folderId, prefix)` | Lists and deletes all non-trashed files whose name contains `prefix` |

The vault folder name on Drive uses the same `sanitizeDbName` transform the plugin uses: non-alphanumeric characters (except `-`) are replaced with `_`.

## Adding a new scenario

**Single-vault test:**
1. Create `tests/wdio/single/<scenario>.e2e.ts`
2. Use `browser.executeObsidian()` to drive Obsidian
3. Resolve the vault folder in `before`; use unique filenames (`Date.now()`)
4. Assert against Drive using `pollForFile` / `pollForFileGone`

**Cross-vault test:**
1. Add a new `it(...)` block to `tests/wdio/cross/cross-vault-sync.e2e.ts`
2. Use `execVault(primary(), ...)` / `execVault(peer(), ...)` to drive each instance
3. Use `triggerSync(b)` to wake up sync in a vault after a remote change
4. Use `waitForVaultFile` / `waitForVaultFileGone` to observe the local vault state
