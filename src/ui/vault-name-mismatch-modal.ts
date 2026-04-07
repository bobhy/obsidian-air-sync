import { App, Modal } from "obsidian";

/**
 * Shown when the local Obsidian vault name does not match the vault name
 * stored in Google Drive's `.airsync/metadata.json`.
 *
 * The connection always fails after this modal is dismissed. The user must
 * rename their local Obsidian vault to match the shared name before retrying.
 */
export class VaultNameMismatchModal extends Modal {
	private readonly localName: string;
	private readonly remoteName: string;
	private readonly onDismiss: () => void;

	private constructor(
		app: App,
		localName: string,
		remoteName: string,
		onDismiss: () => void,
	) {
		super(app);
		this.localName = localName;
		this.remoteName = remoteName;
		this.onDismiss = onDismiss;
	}

	/** Show the modal and resolve when the user dismisses it. */
	static prompt(app: App, localName: string, remoteName: string): Promise<void> {
		return new Promise((resolve) => {
			new VaultNameMismatchModal(app, localName, remoteName, resolve).open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;

		contentEl.createEl("h2", { text: "Vault name mismatch" });
		contentEl.createEl("p", {
			text:
				`Local vault name "${this.localName}" does not match the Google Drive ` +
				`shared vault name "${this.remoteName}". ` +
				`You must rename the local Obsidian vault to "${this.remoteName}" to resolve this.`,
		});

		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
		buttonRow.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
		this.onDismiss();
	}
}
