import { App, Modal, Setting } from 'obsidian';

export interface ToolConfirmationRequest {
  toolName: string;
  description: string;
  filePath: string;
  preview: string; // What will change
}

/**
 * Modal that asks the user to approve a vault-modifying tool call.
 * Returns true if the user clicks Allow, false if Deny.
 */
export class ToolConfirmationModal extends Modal {
  private request: ToolConfirmationRequest;
  private resolved = false;
  private resolve: (allowed: boolean) => void;
  private trustSession: boolean;
  private onTrustChanged: (trust: boolean) => void;

  constructor(
    app: App,
    request: ToolConfirmationRequest,
    resolve: (allowed: boolean) => void,
    currentTrust: boolean,
    onTrustChanged: (trust: boolean) => void
  ) {
    super(app);
    this.request = request;
    this.resolve = resolve;
    this.trustSession = currentTrust;
    this.onTrustChanged = onTrustChanged;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('scribe-confirm-modal');

    contentEl.createEl('h3', { text: 'Scribe wants to modify your vault' });

    const infoEl = contentEl.createDiv({ cls: 'scribe-confirm-info' });
    infoEl.createEl('div', {
      cls: 'scribe-confirm-tool',
      text: this.request.description,
    });
    infoEl.createEl('div', {
      cls: 'scribe-confirm-path',
      text: this.request.filePath,
    });

    // Preview of what will happen
    const previewEl = contentEl.createDiv({ cls: 'scribe-confirm-preview' });
    previewEl.createEl('div', {
      cls: 'scribe-confirm-preview-label',
      text: 'Preview:',
    });
    const previewContent = previewEl.createEl('pre', { cls: 'scribe-confirm-preview-content' });
    const truncated =
      this.request.preview.length > 1000
        ? this.request.preview.slice(0, 1000) + '\n\n[truncated]'
        : this.request.preview;
    previewContent.setText(truncated);

    // Trust this session checkbox
    new Setting(contentEl)
      .setName('Trust this session')
      .setDesc("Don't ask again until I start a new chat")
      .addToggle((toggle) =>
        toggle.setValue(this.trustSession).onChange((value) => {
          this.trustSession = value;
        })
      );

    // Buttons
    const buttonRow = contentEl.createDiv({ cls: 'scribe-confirm-buttons' });

    const denyBtn = buttonRow.createEl('button', { text: 'Deny' });
    denyBtn.addEventListener('click', () => {
      this.resolved = true;
      this.resolve(false);
      this.close();
    });

    const allowBtn = buttonRow.createEl('button', {
      text: 'Allow',
      cls: 'mod-cta',
    });
    allowBtn.addEventListener('click', () => {
      this.resolved = true;
      this.onTrustChanged(this.trustSession);
      this.resolve(true);
      this.close();
    });

    // Focus the allow button for quick Enter key approval
    allowBtn.focus();
  }

  onClose(): void {
    if (!this.resolved) {
      this.resolve(false); // Closing the modal = deny
    }
  }
}
