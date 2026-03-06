import { App, PluginSettingTab, Setting } from 'obsidian';
import type ScribePlugin from './main';

export interface ScribeSettings {
  apiKey: string;
}

export const DEFAULT_SETTINGS: ScribeSettings = {
  apiKey: '',
};

// Key for Obsidian's SecretStorage (OS keychain)
const SECRET_KEY = 'obsidian-scribe-api-key';

export async function loadApiKey(plugin: ScribePlugin): Promise<string> {
  // Try SecretStorage first, fall back to settings for migration
  const secret = await plugin.app.loadLocalStorage(SECRET_KEY);
  if (secret) return secret;
  if (plugin.settings.apiKey) {
    // Migrate plaintext key to SecretStorage
    await saveApiKey(plugin, plugin.settings.apiKey);
    plugin.settings.apiKey = '';
    await plugin.saveSettings();
    return await plugin.app.loadLocalStorage(SECRET_KEY) ?? '';
  }
  return '';
}

export async function saveApiKey(plugin: ScribePlugin, key: string): Promise<void> {
  await plugin.app.saveLocalStorage(SECRET_KEY, key);
}

export class ScribeSettingTab extends PluginSettingTab {
  plugin: ScribePlugin;

  constructor(app: App, plugin: ScribePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Obsidian Scribe Settings' });

    new Setting(containerEl)
      .setName('Claude API Key')
      .setDesc('Your Anthropic API key. Stored securely in your OS keychain.')
      .addText((text) => {
        text
          .setPlaceholder('sk-ant-...')
          .setValue(this.plugin.apiKey ? '••••••••' : '')
          .onChange(async (value) => {
            if (value && !value.startsWith('••')) {
              await saveApiKey(this.plugin, value);
              this.plugin.apiKey = value;
            }
          });
        text.inputEl.type = 'password';
      });
  }
}
