# Remote Vault folder rendezvous
When multiple clients use the same Obsidian vault name, they should automatically and *reliably* share the same remote vault folder in the cloud service.
At the same time, each client should attempt should avoid doing a full sync with a newly discovered remote vault folder, if it can *reliably* determine that it can do so.  
But it's more important that the client discover an existing remote vault folder than that it avoid unnecessary full sync.

On startup, the plugin shall:
- use the host name of the device running Obsidian as a "client id" to distinguish multiple clients using the same remote vault folder
- use the Obsidian vault name as the name of the remote vault folder to look for (in cloud, under 'obdidian-air-sync') *and* 
as the key in `InstanceStore` to locate any previous sync history for this vault in the local device.
- check for the same sync "signature" (described below) in the local `InstanceStore` and in the remote vault folder for this client.  
If the signature is the same, the client can resume incremental sync bnetween `InstanceStore`and the remote vault folder; 
if the signature is not found in either location or is different, then plugin shall start with a full sync.

Sync "signature"
- signature is a hash over the last sync operation that actually modified any files locally or remotely.
- signature shall include the vault paths modified *and* the sync operation that was done to each.  It should avoid timestamps, to avoid clock skew ambiguities.
- when a new signature is computed it shall be cached in both `InstanceStore`, keyed by vault name *and* in the remote vault folder, keyed by client id (e.g in path `.airsync/<clientId>`, contents are the signature)

## refactorings
1. remove the migration code implemented in ./multi-device.md/#Bootstrap_Migration and all tests related to this
2. define a new constant (under google drive backend) with value of 'obsidian-air-sync/' and replace all existing values with a reference to the constant.

## implementation notes
- No need for migration code from existing sync history mechanisms. 
- Provide a "Delete cached sync history" option under plugin advanced settings which deletes all sync history in `InstanceStore` for this vault. 
This option does not itself initiate a new (full) sync.  The next regularly scheduled sync operation will then be a full sync.
- When planning a full sync, if the operation would delete or modify more than 10% of vault files, plugin shall display a modal and get confirmation from the user before proceeding.  
If the user does not confirm, no local vault files should be changed.

## tests
- cover all combination of sync history states: 
	- local client sync history found/not found in `InstanceStore`
	- client sync history found/not found in remote vault folder
	- sync signature found/not found/matches/not matches when local sync hsitory and remote vault folder exist.
