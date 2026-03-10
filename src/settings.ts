import { App, Notice, PluginSettingTab, SecretComponent, Setting, requestUrl } from 'obsidian';
import type AnthracitePlugin from './main';

export interface ClaudeModel {
  id: string;
  name: string;
  supportsThinking: boolean;
  supportsVision: boolean;
}

export const CLAUDE_MODELS: ClaudeModel[] = [
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', supportsThinking: true, supportsVision: true },
  { id: 'claude-haiku-4-20250414', name: 'Claude Haiku 4', supportsThinking: false, supportsVision: true },
  { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', supportsThinking: true, supportsVision: true },
];

export interface AnthraciteSettings {
  apiKeySecretName: string;
  modelId: string;
  extendedThinking: boolean;
  agentMode: boolean;
  historyFolder: string;
  maxToolCalls: number;
  systemPromptPath: string;
  backupReminderDismissed: boolean;
}

export const DEFAULT_SETTINGS: AnthraciteSettings = {
  apiKeySecretName: '',
  modelId: 'claude-sonnet-4-20250514',
  extendedThinking: false,
  agentMode: false,
  historyFolder: 'Anthracite/History',
  maxToolCalls: 25,
  systemPromptPath: '',
  backupReminderDismissed: false,
};

const MIGRATION_SECRET_NAME = 'anthracite-api-key';
const LEGACY_STORAGE_KEY = 'obsidian-scribe-api-key'; // Keep old key name for migration

export async function migrateApiKeyToSecretStorage(plugin: AnthracitePlugin): Promise<void> {
  if (plugin.settings.apiKeySecretName) return;

  const legacyKey = await plugin.app.loadLocalStorage(LEGACY_STORAGE_KEY);
  if (!legacyKey) return;

  plugin.app.secretStorage.setSecret(MIGRATION_SECRET_NAME, legacyKey);

  const verified = plugin.app.secretStorage.getSecret(MIGRATION_SECRET_NAME);
  if (verified === legacyKey) {
    plugin.settings.apiKeySecretName = MIGRATION_SECRET_NAME;
    await plugin.saveSettings();
    await plugin.app.saveLocalStorage(LEGACY_STORAGE_KEY, null);
    console.log('[Anthracite] API key migrated to secure storage');
  } else {
    console.error('[Anthracite] API key migration verification failed');
  }
}

export class AnthraciteSettingTab extends PluginSettingTab {
  plugin: AnthracitePlugin;

  constructor(app: App, plugin: AnthracitePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Anthracite Settings' });

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
      .setName('Model')
      .setDesc('Which Claude model to use for chat. Opus is most capable but slower and costs more. Haiku is fastest and cheapest.')
      .addDropdown((dropdown) => {
        for (const model of CLAUDE_MODELS) {
          dropdown.addOption(model.id, model.name);
        }
        dropdown.setValue(this.plugin.settings.modelId);
        dropdown.onChange(async (value) => {
          this.plugin.settings.modelId = value;
          // Auto-disable thinking if model doesn't support it
          const selected = CLAUDE_MODELS.find((m) => m.id === value);
          if (selected && !selected.supportsThinking && this.plugin.settings.extendedThinking) {
            this.plugin.settings.extendedThinking = false;
            new Notice(`Extended thinking disabled — ${selected.name} doesn't support it.`);
          }
          await this.plugin.saveSettings();
          this.display(); // Refresh to update thinking toggle state
        });
      });

    new Setting(containerEl)
      .setName('System Prompt')
      .setDesc(
        'Path to a vault note to use as your system prompt (e.g. Anthracite/system-prompt). Leave empty for the default prompt. The note content replaces the built-in instructions.'
      )
      .addText((text) =>
        text
          .setPlaceholder('e.g. Anthracite/system-prompt')
          .setValue(this.plugin.settings.systemPromptPath)
          .onChange(async (value) => {
            this.plugin.settings.systemPromptPath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Chat History Folder')
      .setDesc('Where to save chat conversations as Markdown files.')
      .addText((text) =>
        text
          .setPlaceholder('Anthracite/History')
          .setValue(this.plugin.settings.historyFolder)
          .onChange(async (value) => {
            this.plugin.settings.historyFolder = value || 'Anthracite/History';
            await this.plugin.saveSettings();
          })
      );

    const selectedModel = CLAUDE_MODELS.find((m) => m.id === this.plugin.settings.modelId);
    const thinkingSupported = selectedModel?.supportsThinking ?? false;

    new Setting(containerEl)
      .setName('Extended Thinking')
      .setDesc(
        thinkingSupported
          ? 'Enable extended thinking for deeper analysis. Claude will show its reasoning process in a collapsible block. Uses more tokens.'
          : `Extended thinking is not available with ${selectedModel?.name || 'this model'}.`
      )
      .addToggle((toggle) => {
        toggle
          .setValue(thinkingSupported && this.plugin.settings.extendedThinking)
          .setDisabled(!thinkingSupported)
          .onChange(async (value) => {
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
