# Remote Vault folder rendezvous
When multiple clients use the same Obsidian vault name, they should automatically and *reliably* share the same remote vault folder in the cloud service.
At the same time, each client should attempt should avoid doing a full sync with a newly discovered remote vault folder, if it can *reliably* determine that it can do so.  
But it's more important that the client discover an existing remote vault folder than that it avoid unnecessary full sync.
This preference for reliability means there may be more full syncs than are strictly necessary and user docs (and logging) should indicate that,
and describe the sanity checks that protect against unexpectedly destructive syncs.

On startup, the plugin shall:
- use a device-based ID as a "client id" to distinguish multiple clients using the same remote vault folder
- use the Obsidian vault name as the name of the remote vault folder to look for (in cloud, under 'obsidian-air-sync') *and*
as the key in `SyncStateStore` and `InstanceStore` to locate any previous sync history for this vault in the local device.
- check for the same sync "signature" (described below) in the local `SyncStateStore` and in the remote vault folder for this client.  
If the signature is the same, the client can resume incremental sync bnetween `SyncStateStore`and the remote vault folder;
if the signature is not found in either location or is different, then plugin shall start with a full sync.

## Sync "signature"
- signature is a hash over the last sync operation that actually modified any files locally or remotely. Signature is not updated if no changes are needed in a sync pass.  
Order of elements included in the hash is not specified, all we need is a semi-unique identifier for a local sync pass.  That value will be copied to the remote folder, but not recomputed independently.
It is initialized to 0 when a new cached sync history is initialized.
- signature shall include the vault paths modified *and* the sync operation that was done to each.  It should avoid timestamps, to avoid clock skew ambiguities.  
- After a new signature is computed it shall be cached both locally *and* in the remote vault folder. It should be written after the sync operation completes and only if it completes entirely without error.
Since remote writes are more risky, the signature update to the remote vault should be performed first.  
This ordering provides more robust sync operation: when the plugin *is* able to read both signatures the plugin can rely on the match to safely do an incremental sync.  
If any error prevented update of the cached signatures, the plugin will fall back to a full sync which will restore a consistent state.
Locally, the signature should be stored in `InstanceStore` (as a non-synced setting value).
Remotely, the signature should be stored in path `.airsync/<clientId>.json`, contents are a JSON object with key `lastSyncSignature`.

This design uses simple, externally managed names to cache sync history and to discover shared remote vault folders.  
It uses the official hostname of the client to distinguish multiple clients sharing the same remote vault folder.
This hostname is determined differently on different platforms, using a reliable, native API.  
If there is no native API for hostname, use a UUID that is stable for that device (meaning all instances of the plugin on that device will always use the same UUID each time they load., see "Client ID" in settings)
It uses the current obsidian vault name to distinguish multiple instances of the plugin running on the local device.  
The user could create conflicts by changing these names and the plugin might misbehave.  
The plugin does have some sanity checks to avoid misbehaving, and falls back to performing a full sync when it detects questionable data.  
And the full sync has sanity checks to avoid making too destructive changes automatically.  
So the conservative advice to users is 1) to avoid renaming a device hostname or an Obsidian vault after deploying this plugin and 2) be especially cautious before renaming to a hostname or vault name that this user has ever used before.  

## refactorings
1. remove the migration code implemented in ./multi-device.md/#Bootstrap_Migration and all tests related to this
2. define a new constant (under google drive backend) with value of 'obsidian-air-sync/' and replace all existing values with a reference to the constant.
3. existing `vaultId` as an identifier should be replaced with (a sanitized form of) Obsidian vault name wherever it is used.
Since this would prevent desktop from syncing from 2 vaults with the same name but in different full filesystem paths:
    a. plugin should save the full vault path to `InstanceStore` (keyed by vault name)
    b. if plugin finds a different full vault path when attempting to save the current full vault path, it should issue a fatal error message to that effect.
    c. user doc should include the restriction that the plugin does not support having multiple local obsidian vaults with the same name but different full file paths
    and will fail to initialize a conflicting vault.

## Settings
- "Remote Vault Folder" (successor to remoteVaultFolderId)
The *name* of the folder in Google Drive and is a sanitized form of the Obsidian vault name.  
A read-only field, displayed here so the user can see the exact folder name used in the remote service.  
The only way for user to change the remote folder name is to change the local Obsidian vault name.  
If the user manually renames the google folder, the plugin will create a new folder with the current vault name.
- "Client ID" a new advanced setting to show the hostname or UUID being used as client file name to cache signature in the remote vault folder.
On any platform where device hostname is available by native API, the client id is the official host name, and the setting field is read only.
On other platforms, the client ID is an opaque GUID, displayed as `Client_<guid>`, and is generated by the first plugin instance to initialize and reused by all subsequent plugin instances.  
This field is read/write and changable by the user (and the changed value will be used by all other instances of the plugin).
The value is persisted under a reserved fixed key `__device__` in `InstanceStore`.
If the user changes the client ID, it forces a full resync in all instances on that device.
- "Delete cached sync history" button in advanced settings which clears the sync signature in `InstanceStore` and deletes all sync history in `SyncStateStore` for this vault.
This option does not itself initiate a new (full) sync.  The next regularly scheduled sync operation will then be a full sync.

## Command Pallete
- add a new command in the command pallete: `Airsync: pause sync`.
This allows a user who is being flooded with sync failures to disable sync while working on manual corrections.

## Logging
- plugin should log at WARNING severity these situations:
    - when local vault has a cached last-sync signature but newly opened remote vault folder does not or has a different signature (for that client)
    - when newly opened remote vault has a signature for that client but local vault does not, or has a different one.
    In both of these cases, plugin will perform a full sync to get to a consistent state.
- plugin should log at INFO severity:
    - found / not found local sync history under vault key, showing sync signature if present.
    - found / not found remote vault folder, showing sync signature if present.
    - the resumption scenario it is going to use, given presence or absence of local cached sync history and presence or absence of remote vault folder and matching sync signature.
    alternatives might be 'start with full sync' or 'resuming existing sync session'

## tests
- cover all combination of sync history states:
    - local client sync history found/not found in `SyncStateStore`
    - client sync history found/not found in remote vault folder
    - sync signature found/not found/matches/not matches when local sync hsitory and remote vault folder exist.
    - client ID is generated correctly on all supported platforms: value is official hostname on platforms where that is available by native API; as generated GUID otherwise.  We want to use native hostname where possible.

## other implementation notes
- No need for migration code from existing sync history mechanisms.
This means user might need to manually delete old folders in google drive or that existing records in local DBs might be orphaned (with no user-visible way to clean up).
- existing setting `backendData.googledrive.remoteVaultFolderId` is replaced by `.remoteVaultFolder`, described above in Settings.
- When planning a full sync, if the operation would delete or modify more than 10% of vault files, plugin shall display a modal and get confirmation from the user before proceeding.
10% criterion counts existing files that would be deleted or modified, but not new files that would be created.  Scope is all files configured for sync (obeying explicit include or ignore configuration)
If the user does not confirm, no local vault files should be changed.
Therefore, the same message will recur in subsequent sync passes until the user manually corrects the situation.
