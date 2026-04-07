# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Feat: Make it easy to add a new device to group of devices already syncing same vault.
- Plugin folder (`{configDir}/plugins/obsidian-air-sync`) is now included in the synced dot-paths by
  default.
- Per-device settings (`vaultId`, `enableLogging`, `logLevel`, OAuth token expiry) are now stored in
  IndexedDB instead of `settings.json`, so `settings.json` and the entire plugin folder can be safely
  synced across devices. Each vault on a shared Obsidian install gets its own isolated record keyed by
  vault name and config directory.
- `settings.json` is now split into syncable (group) settings and per-device (instance) settings at the
  persistence boundary. The file written to disk no longer contains any device-specific values.
- Connect button now detects the join scenario automatically. If no existing remote vault is found
  for this vault name a new sync group is created. If an existing group is found and this device
  previously synced with it, a "Resuming sync" toast is shown. If the local vault is empty, group
  settings are downloaded and applied before the first sync so the new device immediately inherits
  the group's configuration. If the local vault already has content that has never been synced with
  the group, a modal prompts to Cancel or Combine vaults; Cancel disconnects cleanly, Combine seeds
  settings from the remote and proceeds.

### Fixed

- Stale IDB sync records are now discarded on plugin reinstall, to avoid trashing `.airsync/metadata.json` in remote vault if local vault was empty.
Previously, reinstalling the plugin
  (which deletes `settings.json`) left orphaned sync records in IndexedDB. On the first sync after
  reinstall, warm-mode change detection would see `.airsync/metadata.json` as locally deleted and
  issue a `delete_remote`, trashing the remote vault identity file on Google Drive. The fix: if
  `loadData()` returns null on startup, the orchestrator clears all sync records before the first
  sync, forcing a safe cold scan.
- `changesStartPageToken` removed from `settings.json` and `backendData`; the MetadataStore IndexedDB
  is now the sole authoritative store for this value.
- OAuth PKCE state (`pendingAuthState`, `pendingCodeVerifier`) is no longer written to `settings.json`;
  it is kept in memory only for the duration of the auth flow, with a debug log if the plugin reloads
  mid-flow.

## [0.1.17] - 2026-03-29

### Added
- Rename/move propagation: local file renames are now detected and pushed to the remote as
  native rename operations rather than a delete + re-upload.
- Remote renames are applied locally using the native `localFs.rename()` API when available.
- Folder renames are coalesced into a single rename action so that moving a directory does
  not generate one action per descendant file.

### Fixed
- Rename optimization was not firing when the hot filter or hash comparison rejected
  candidate pairs.
- Remote folder-rename coalescing was scanning sync actions instead of file pairs.
- `isFolder` flag was not being set on full-scan-delta rename pairs; consumed pairs were
  not being filtered out after a folder rename matched.
- Deleted old paths were not being reported when a remote file was moved or renamed.
