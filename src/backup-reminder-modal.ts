import { App, Modal, Setting } from 'obsidian';

/**
 * One-time modal shown before the first vault write operation.
 * Reminds users to back up their vault before agent mode makes changes.
 * "Don't show again" persists to plugin settings.
 */
export class BackupReminderModal extends Modal {
  private resolved = false;
  private dontShowAgain = false;
  private resolve: (result: { proceed: boolean; dismiss: boolean }) => void;

  constructor(
    app: App,
    resolve: (result: { proceed: boolean; dismiss: boolean }) => void
  ) {
    super(app);
    this.resolve = resolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('anthracite-backup-modal');

    contentEl.createEl('h3', { text: 'Back up your vault first?' });

    contentEl.createEl('p', {
      text: 'Anthracite is about to make changes to your vault. While edits are carefully reviewed, we recommend having a backup of your vault before using Agent Mode.',
    });

    contentEl.createEl('p', {
      cls: 'anthracite-backup-suggestions',
      text: 'Options: Git version control, a cloud sync folder, or simply copy your vault folder.',
    });

    new Setting(contentEl)
      .setName("Don't remind me again")
      .addToggle((toggle) =>
        toggle.setValue(false).onChange((value) => {
          this.dontShowAgain = value;
        })
      );

    const buttonRow = contentEl.createDiv({ cls: 'anthracite-confirm-buttons' });

    const cancelBtn = buttonRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => {
      this.resolved = true;
      this.resolve({ proceed: false, dismiss: this.dontShowAgain });
      this.close();
    });

    const proceedBtn = buttonRow.createEl('button', {
      text: 'Continue',
      cls: 'mod-cta',
    });
    proceedBtn.addEventListener('click', () => {
      this.resolved = true;
      this.resolve({ proceed: true, dismiss: this.dontShowAgain });
      this.close();
    });

    proceedBtn.focus();
  }

  onClose(): void {
    if (!this.resolved) {
      this.resolve({ proceed: false, dismiss: false });
    }
  }
}
