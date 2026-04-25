import { App, Modal } from "obsidian";

/**
 * Shown when a sync plan would delete or overwrite more than the user's configured
 * threshold percentage of locally known files.
 */
export class DestructiveSyncModal extends Modal {
	private readonly destructiveCount: number;
	private readonly knownFileCount: number;
	private readonly threshold: number;
	private readonly onResult: (confirmed: boolean) => void;

	private constructor(
		app: App,
		destructiveCount: number,
		knownFileCount: number,
		threshold: number,
		onResult: (confirmed: boolean) => void,
	) {
		super(app);
		this.destructiveCount = destructiveCount;
		this.knownFileCount = knownFileCount;
		this.threshold = threshold;
		this.onResult = onResult;
	}

	/** Show the modal and resolve with true (proceed) or false (skip). */
	static prompt(app: App, destructiveCount: number, knownFileCount: number, threshold: number): Promise<boolean> {
		return new Promise((resolve) => {
			new DestructiveSyncModal(app, destructiveCount, knownFileCount, threshold, resolve).open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;
		const pct = Math.round((this.destructiveCount / this.knownFileCount) * 100);

		contentEl.createEl("h2", { text: "Large sync detected" });
		contentEl.createEl("p", {
			text:
				`This sync would delete or overwrite ${this.destructiveCount} of ` +
				`${this.knownFileCount} tracked files (${pct}%). ` +
				`This exceeds your ${this.threshold}% destructive sync threshold.`,
		});
		contentEl.createEl("p", {
			text: "Proceed with the sync, or skip this cycle and review manually?",
		});

		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
		buttonRow.createEl("button", { text: "Proceed", cls: "mod-cta" }).addEventListener("click", () => {
			this.close();
			this.onResult(true);
		});
		buttonRow.createEl("button", { text: "Skip this sync" }).addEventListener("click", () => {
			this.close();
			this.onResult(false);
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
