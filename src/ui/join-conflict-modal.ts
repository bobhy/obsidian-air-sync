import { App, Modal } from "obsidian";

/**
 * Shown when the user connects to a remote vault that exists on Drive but this
 * local vault has never synced with it and already has content.
 *
 * Options:
 * - Cancel  → abort the connection; leave the local vault unchanged
 * - Combine → merge local and remote contents using group settings
 */
export class JoinConflictModal extends Modal {
	private vaultName: string;
	private resolve: (result: "cancel" | "combine") => void;

	private constructor(
		app: App,
		vaultName: string,
		resolve: (result: "cancel" | "combine") => void,
	) {
		super(app);
		this.vaultName = vaultName;
		this.resolve = resolve;
	}

	/** Show the modal and return the user's choice. */
	static prompt(app: App, vaultName: string): Promise<"cancel" | "combine"> {
		return new Promise((resolve) => {
			new JoinConflictModal(app, vaultName, resolve).open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;

		contentEl.createEl("h2", { text: "Remote vault already exists" });
		contentEl.createEl("p", {
			text:
				`A sync group for vault "${this.vaultName}" already exists in your cloud storage, ` +
				`but this local vault also has content that has never been synced. ` +
				`How would you like to proceed?`,
		});

		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });

		buttonRow.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
			this.close();
			this.resolve("cancel");
		});

		const combineBtn = buttonRow.createEl("button", {
			text: "Combine vaults",
			cls: "mod-cta",
		});
		combineBtn.addEventListener("click", () => {
			this.close();
			this.resolve("combine");
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
