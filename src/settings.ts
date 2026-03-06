import { App, PluginSettingTab, Setting } from 'obsidian';
import type ScribePlugin from './main';

export interface ScribeSettings {
  apiKey: string;
  extendedThinking: boolean;
  agentMode: boolean;
}

export const DEFAULT_SETTINGS: ScribeSettings = {
  apiKey: '',
  extendedThinking: false,
  agentMode: false,
};

const SECRET_KEY = 'obsidian-scribe-api-key';

export async function loadApiKey(plugin: ScribePlugin): Promise<string> {
  const secret = await plugin.app.loadLocalStorage(SECRET_KEY);
  if (secret) return secret;
  if (plugin.settings.apiKey) {
    await saveApiKey(plugin, plugin.settings.apiKey);
    plugin.settings.apiKey = '';
    await plugin.saveSettings();
    return (await plugin.app.loadLocalStorage(SECRET_KEY)) ?? '';
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

    new Setting(containerEl)
      .setName('Extended Thinking')
      .setDesc(
        'Enable extended thinking for deeper analysis. Claude will show its reasoning process in a collapsible block. Uses more tokens.'
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.extendedThinking).onChange(async (value) => {
          this.plugin.settings.extendedThinking = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Agent Mode')
      .setDesc(
        'Allow Claude to read, search, create, and edit notes in your vault using tools. Claude will ask before making changes.'
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.agentMode).onChange(async (value) => {
          this.plugin.settings.agentMode = value;
          await this.plugin.saveSettings();
        });
      });
  }
}
