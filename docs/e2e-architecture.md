# E2E test architecture

The E2E suite exercises the plugin against a live Obsidian desktop instance and real Google Drive. No mocking — every sync cycle runs the full stack.

## Prerequisites

- Obsidian desktop installed, with the official Obsidian CLI available as `obsidian` on `$PATH`
- A Google account used to connect the test vault to Google Drive

## One-time setup

```bash
npm run setup:e2e
# or, for a non-default location:
OBSIDIAN-E2E-ROOT=~/my-test-vaults npm run setup:e2e
```

`setup:e2e` is interactive:

1. Creates `$E2E_ROOT/air-sync-e2e/` and installs the built plugin into it
2. Prompts you to open that folder as a vault in Obsidian and enable community plugins
3. Prompts you to complete the Google Drive OAuth flow inside the plugin settings
4. Reads the resulting refresh token from vault SecretStorage via `obsidian eval` and validates it against the auth server
5. Exits with an error if the token is missing or rejected — so a successful exit means the vault is ready

The refresh token is stored in Obsidian's SecretStorage, not in any file. Subsequent runs retrieve it automatically; you do not need to redo the OAuth flow unless the token expires or is revoked.

## Running tests

```bash
npm run test:e2e
```

`pretest:e2e` runs `npm run build` first, so tests always exercise the latest code.

## Directory layout

```
tests/e2e/
  helpers/
    env.ts          — vault path constants and env var helpers
    cli.ts          — wrappers around the Obsidian CLI
    gdrive.ts       — GDrive REST API helpers (token management, file polling)
  global-setup.ts   — Vitest globalSetup: deploy artifacts, configure vault, reload plugin
  setup-vault.ts    — One-time interactive setup script (npm run setup:e2e)
  create-sync.e2e.ts
  delete-sync.e2e.ts
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `OBSIDIAN-E2E-ROOT` | `~/obsidian-test` | Parent directory for all test vaults |

The vault name is always `air-sync-e2e`. The vault path is `$OBSIDIAN-E2E-ROOT/air-sync-e2e`.

## How a test run works

### globalSetup (`global-setup.ts`)

Runs once before any test file, outside the test worker:

1. Verifies the test vault exists (fails fast with a clear message if `setup:e2e` was never run)
2. Copies `main.js`, `manifest.json`, and `styles.css` (if present) from the project root into the vault's plugin directory — ensuring the freshly built plugin is installed
3. Patches `data.json` to set `destructiveSyncThreshold: 100` so the destructive-sync confirmation modal never blocks tests
4. Opens the vault (`obsidian vault=air-sync-e2e`) and waits 3 s for Obsidian to finish loading
5. Reloads the plugin (`obsidian plugin:reload obsidian-air-sync`) so the new build is active

### Per-test flow

Each test file resolves the GDrive vault folder ID in `beforeAll` via `resolveVaultFolder(VAULT_NAME)`, then each test:

1. Creates a uniquely named note (timestamp suffix) using the Obsidian CLI
2. Polls Google Drive directly to observe the side effect
3. Cleans up

Tests are isolated by unique filenames — no shared state, no ordering dependency.

## Helpers reference

### `helpers/env.ts`

- `E2E_ROOT` — resolved vault root directory
- `VAULT_NAME` — `"air-sync-e2e"`
- `VAULT_PATH` — full path to the test vault
- `requireEnv(name)` — reads a required env var, throws if missing

### `helpers/cli.ts`

Thin wrappers around the Obsidian CLI (`obsidian <command>`).

- `openVault()` — switches Obsidian to the test vault; waits 3 s for load
- `createNote(name)` — creates a new note in the active vault via `obsidian create name="<name>"`; triggers the plugin's file-created handler

### `helpers/gdrive.ts`

All GDrive access uses the Drive REST API v3 directly with `fetch`. Tokens are managed internally.

**Token pipeline:**

1. `evalVaultSecret("air-sync-googledrive-refresh-token")` — runs `obsidian eval 'code=app.secretStorage.getSecret(...)'`, strips the `=> ` REPL prefix, and JSON-parses the result to extract the raw token string
2. `getAccessToken()` — exchanges the refresh token via `POST https://auth-smartsync.takezo.dev/google/token/refresh`; caches the access token until 60 s before expiry
3. All GDrive calls attach the access token as a `Bearer` header

**Exported functions:**

- `evalVaultSecret(key)` — reads a named secret from the active vault's SecretStorage; returns `null` if not found
- `resolveVaultFolder(vaultName)` — walks `My Drive / obsidian-air-sync / <sanitized-vault-name>` and returns the Drive folder ID; throws if not found
- `pollForFile(folderId, filename, timeoutMs?)` — polls every 2 s until a file with the given name appears in the folder; default timeout 30 s
- `pollForFileGone(fileId, timeoutMs?)` — polls every 2 s until the file is deleted or trashed; default timeout 30 s

The vault folder name on Drive uses the same `sanitizeDbName` the plugin uses: non-alphanumeric characters (except `-`) are replaced with `_`.

## Vitest configuration (`vitest.e2e.config.ts`)

- `include` — `tests/e2e/**/*.e2e.ts` (separate glob from unit tests)
- `testTimeout` — 120 s (sync round-trips can take 10–20 s)
- `hookTimeout` — 30 s
- `pool: "forks"` — each test file runs in its own process; avoids shared module state between suites

Unit tests (`npm test`) use `vitest.config.ts` and never include `*.e2e.ts` files.

## Cross-vault sync scenarios

To test syncing between two vaults sharing the same Drive folder, set the peer vault's "Remote
vault folder" to the same name as the primary vault before connecting it to Google Drive. With the
plugin disconnected in the peer vault, write the desired name to `data.json`:

```json
{ "remoteVaultFolderName": "air-sync-e2e" }
```

`global-setup.ts` can write this before reloading the plugin in the peer vault, so no manual UI
interaction is needed. On connect, `resolveGDriveRemoteVault` looks up that name and lands on the
same Drive folder already used by the primary vault.

## Adding a new scenario

1. Create `tests/e2e/<scenario>.e2e.ts`
2. Resolve the vault folder in `beforeAll`; give each test a unique filename using `Date.now()`
3. Drive events with CLI helpers (`createNote`, etc.) or OS-level operations (`fs.rm` for deletions — Obsidian's file watcher picks these up)
4. Assert against GDrive using `pollForFile` / `pollForFileGone`

For scenarios that modify plugin settings transiently, patch `data.json` in a `beforeAll` and restore it in `afterAll`; then reload the plugin via `execAsync("obsidian plugin:reload obsidian-air-sync")`.
