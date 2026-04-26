# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- **Remote vault folder name** setting in Google Drive connection settings.  
  Defaults to the local vault name (the previous hard-coded behaviour), but can now be set to any
  value while the plugin is disconnected from Google Drive.  
  This allows two vaults with different local names to share the same Drive folder, or a vault to
  be renamed locally without losing its sync history in Drive.  
  Changing the setting clears local sync history so the next sync is a clean full scan against
  the newly targeted folder.  
  The setting is preserved across disconnect/reconnect cycles.

## [0.3.1] - 2026-04-26
### Fixed
- support the scenario of multiple clients running on same device, 
  syncing to the same remote folder using the same local vault name
  but different local paths to the vault.  
  Client name now `<hostname>_<pathHash>` on non-mobile platforms (where hostname is available)
  and `client_<deviceGuid>_<vaultGuid>` on mobile platforms (even though mobile may 
  not support running multiple clients simultaneously)
- added npm script to deploy newly-built plugin to local vault(s)  
  `npm run deploy -- /path/to/vault1 /path/to/vault2`

## [0.3.0] - 2026-04-25
### Changed
- remote vault folder rendezvous and sync session resumption  
  Plugin looks for remote folder whose name matches current obsidian vault name.  
  Doesn't depend on finding `.airsync/metadata.json` with correct `vaultName` key.
- client now computes a hash over last synced files and operations and caches that 
  locally and in the remote folder (in file `.airsync/<clientId>.json`).  
  When both signatures exist and actually match, client knows its safe to trust 
  local sync history and resumes doing incremental syncs.  If signatures don't match, 
  client does a full sync (and caches new sync signatures).  
- changed handling of "too many" changes planned in a sync operation  
  Added a modal dialog asking for explicit user OK before doing a sync that would delete or modify 
  "too many" local files (settable, default is 10%).  If user decides not to allow, the current sync
  operation is aborted, but the next regular sync cycle may retrigger it.  
- changed settings to display the remote actual folder name and client id used to identify this instance.

### Added
- plugin command to toggle sync processing.  User can now pause and later resume scheduled sync operations 
  (e.g to deal with "too many changes" popups).

## [0.2.1] - 2026-04-08

### Changed

- Removed remote-vault rename support introduced in 0.2.0. Obsidian does not permit renaming
  the currently open vault through the vault manager, so the rename-detection logic was
  unreachable in practice.
- When connecting via a cached folder ID, if `.airsync/metadata.json` is missing or contains
  no `vaultName`, the plugin now writes the local vault name into it rather than failing.
  This covers two legitimate cases: initial creation of a remote vault and recovery after
  accidental deletion of the metadata file.
- A name mismatch between the local vault and `metadata.json` still shows an error modal and
  aborts the connection, unchanged from 0.2.0.
  
## [0.2.0] - 2026-03-29

### Changed

- Forked from version 0.1.17 of Takehito Gondo, without whose original design we would be lost.
  Starting new release chain at 0.2.0.

- `.airsync` (the sync-state folder) is no longer synced by default. Users who want it
  synced can add `.airsync` to the *Dot paths to sync* list. 

- Check for duplicate remote vaults on connect.
  When connecting to Google Drive, all vault folders under `obsidian-air-sync/` are scanned
  for the same vault name. If duplicates are found but one matches the previously connected
  folder (cached folder ID), the user is warned but the matching remote vault is used.
  If duplicates are found but none matches cached ID, the user gets an error and the connection fails —
  the user must manually remove the duplicate vault folder from Google Drive before retrying.

- Improve conflict strategy **Auto merge** (`auto_merge`): to use  `diff3Merge`
  for conflict rendering so that conflict markers span only the lines that actually differ.
  Common leading and trailing lines appear outside the markers, matching git's default
  conflict style.

### Added
- Feat: Handle rename of shared remote vault (imperfectly).
  Because Obsidian doesn't notify plugin when vault is renamed by Obsidian vault manager...
  For now: when multiple devices sync to same remote vault:
  1. on one device, rename the vault via Obsidian vault manager, then *restart* Obsidian and check that the plugin reconnects.
  2. then, on all the other devices using the old vault name, change it to the new.  
  If you happen to restart Obsidian on any device still using the old vault name before you complete step 2,
  the plugin will notice that the remote vault doesn't match the devices's (old) name, and refuse to connect.
  This is your reminder to rename the vault on this device.
  
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
