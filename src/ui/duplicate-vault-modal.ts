import { App, Modal } from "obsidian";
import { AIRSYNC_DIR, METADATA_FILE } from "../constants";

/**
 * Shown when multiple remote vault folders with the same vault name are found
 * in Google Drive and no tiebreaker is available.
 *
 * Only option is Cancel — the connection attempt always fails after this modal
 * is dismissed. The user must clean up Google Drive before retrying.
 */
export class DuplicateVaultModal extends Modal {
	private readonly vaultName: string;
	private readonly count: number;
	private readonly onDismiss: () => void;

	private constructor(
		app: App,
		vaultName: string,
		count: number,
		onDismiss: () => void,
	) {
		super(app);
		this.vaultName = vaultName;
		this.count = count;
		this.onDismiss = onDismiss;
	}

	/** Show the modal and resolve when the user dismisses it. */
	static prompt(app: App, vaultName: string, count: number): Promise<void> {
		return new Promise((resolve) => {
			new DuplicateVaultModal(app, vaultName, count, resolve).open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;

		contentEl.createEl("h2", { text: "Multiple remote vaults found" });
		contentEl.createEl("p", {
			text:
				`Found ${this.count} separate remote vault folders for "${this.vaultName}" ` +
				`in Google Drive. Cannot choose one automatically.`,
		});
		contentEl.createEl("p", {
			text:
				`To fix this, open Google Drive, locate the "obsidian-air-sync" folder, ` +
				`check the contents of "${AIRSYNC_DIR}/${METADATA_FILE}" for "vaultName", and delete the redundant ` +
				`vault folder(s) so only one remains ` +
				`for this vault name. Then try connecting again.`,
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
