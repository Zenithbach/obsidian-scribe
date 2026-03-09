import { App, Notice, PluginSettingTab, SecretComponent, Setting, requestUrl } from 'obsidian';
import type ScribePlugin from './main';

export interface ScribeSettings {
  apiKeySecretName: string;
  extendedThinking: boolean;
  agentMode: boolean;
  historyFolder: string;
  maxToolCalls: number;
}

export const DEFAULT_SETTINGS: ScribeSettings = {
  apiKeySecretName: '',
  extendedThinking: false,
  agentMode: false,
  historyFolder: 'Scribe/History',
  maxToolCalls: 25,
};

const MIGRATION_SECRET_NAME = 'scribe-api-key';
const LEGACY_STORAGE_KEY = 'obsidian-scribe-api-key';

export async function migrateApiKeyToSecretStorage(plugin: ScribePlugin): Promise<void> {
  if (plugin.settings.apiKeySecretName) return;

  const legacyKey = await plugin.app.loadLocalStorage(LEGACY_STORAGE_KEY);
  if (!legacyKey) return;

  plugin.app.secretStorage.setSecret(MIGRATION_SECRET_NAME, legacyKey);

  const verified = plugin.app.secretStorage.getSecret(MIGRATION_SECRET_NAME);
  if (verified === legacyKey) {
    plugin.settings.apiKeySecretName = MIGRATION_SECRET_NAME;
    await plugin.saveSettings();
    await plugin.app.saveLocalStorage(LEGACY_STORAGE_KEY, null);
    console.log('[Obsidian Scribe] API key migrated to secure storage');
  } else {
    console.error('[Obsidian Scribe] API key migration verification failed');
  }
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
      .setDesc(
        'Link your Anthropic API key. Create a secret in Obsidian Settings → Secrets, then link it here. Get a key at https://console.anthropic.com/settings/keys'
      )
      .addComponent((el) =>
        new SecretComponent(this.app, el)
          .setValue(this.plugin.settings.apiKeySecretName)
          .onChange(async (secretName) => {
            this.plugin.settings.apiKeySecretName = secretName;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Test Connection')
      .setDesc('Verify your Claude API key is working')
      .addButton((button) =>
        button.setButtonText('Test').onClick(async () => {
          const apiKey = this.plugin.apiKey;
          if (!apiKey) {
            new Notice('No API key linked. Create a secret in Settings → Secrets first.');
            return;
          }
          button.setButtonText('Testing...');
          button.setDisabled(true);
          try {
            const response = await requestUrl({
              url: 'https://api.anthropic.com/v1/models',
              method: 'GET',
              headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
              },
            });
            if (response.status === 200) {
              const data = response.json;
              const count = data.data?.length ?? 0;
              new Notice(`Connection successful — ${count} models available`);
            } else {
              new Notice(`Connection failed: HTTP ${response.status}`);
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`Connection failed: ${msg}`);
          } finally {
            button.setButtonText('Test');
            button.setDisabled(false);
          }
        })
      );

    new Setting(containerEl)
      .setName('Chat History Folder')
      .setDesc('Where to save chat conversations as Markdown files.')
      .addText((text) =>
        text
          .setPlaceholder('Scribe/History')
          .setValue(this.plugin.settings.historyFolder)
          .onChange(async (value) => {
            this.plugin.settings.historyFolder = value || 'Scribe/History';
            await this.plugin.saveSettings();
          })
      );

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

    new Setting(containerEl)
      .setName('Max Tool Calls')
      .setDesc(
        'Maximum number of tool call iterations per message in Agent Mode. Increase for complex tasks like vault reorganization.'
      )
      .addSlider((slider) =>
        slider
          .setLimits(5, 50, 5)
          .setValue(this.plugin.settings.maxToolCalls)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxToolCalls = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
