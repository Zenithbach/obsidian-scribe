import { Plugin } from 'obsidian';
import { ScribeSettings, DEFAULT_SETTINGS, ScribeSettingTab, loadApiKey } from './settings';
import { ChatView, CHAT_VIEW_TYPE } from './chat-view';

export default class ScribePlugin extends Plugin {
  settings: ScribeSettings;
  apiKey: string = '';

  async onload(): Promise<void> {
    await this.loadSettings();
    this.apiKey = await loadApiKey(this);

    // Register the chat sidebar view
    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));

    // Add ribbon icon to open chat
    this.addRibbonIcon('message-circle', 'Open Scribe Chat', () => {
      this.activateChatView();
    });

    // Add command to open chat
    this.addCommand({
      id: 'open-chat',
      name: 'Open chat',
      callback: () => this.activateChatView(),
    });

    // Command to summarize active note
    this.addCommand({
      id: 'summarize-note',
      name: 'Summarize current note',
      callback: () => {
        this.activateChatView();
        // Small delay to ensure view is ready
        setTimeout(() => {
          const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
          if (leaves.length) {
            const view = leaves[0].view as ChatView;
            view.sendPrefilled('Please summarize this note concisely.');
          }
        }, 200);
      },
    });

    // Settings tab
    this.addSettingTab(new ScribeSettingTab(this.app, this));
  }

  async onunload(): Promise<void> {
    // Clean up views
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async activateChatView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);

    if (existing.length) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }
}
