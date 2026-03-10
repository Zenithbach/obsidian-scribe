import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from 'obsidian';
import type AnthracitePlugin from './main';
import { ChatMessage, ClaudeClient, ImageAttachment } from './claude-client';
import { CLAUDE_MODELS } from './settings';
import { ContextBuilder } from './context-builder';
import { VaultToolExecutor } from './vault-tools';
import { ChatHistory } from './chat-history';
import { BackupReminderModal } from './backup-reminder-modal';

export const CHAT_VIEW_TYPE = 'anthracite-chat-view';

export class ChatView extends ItemView {
  plugin: AnthracitePlugin;
  private messages: ChatMessage[] = [];
  private messagesContainer: HTMLElement;
  private textarea: HTMLTextAreaElement;
  private sendButton: HTMLButtonElement;
  private contextBanner: HTMLElement;
  private client: ClaudeClient | null = null;
  private contextBuilder: ContextBuilder;
  private toolExecutor: VaultToolExecutor;
  private isStreaming = false;
  private thinkingContainer: HTMLElement | null = null;
  private pendingImages: { base64: string; mediaType: string }[] = [];
  private chatHistory: ChatHistory;
  private currentThinking: string = '';
  private currentToolCalls: { name: string; input: Record<string, unknown>; result: string }[] = [];
  private thinkingAutoCollapsed = false;

  constructor(leaf: WorkspaceLeaf, plugin: AnthracitePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.contextBuilder = new ContextBuilder(plugin.app);
    this.toolExecutor = new VaultToolExecutor(plugin.app, [plugin.settings.historyFolder]);
    this.setupBackupReminder();
    this.chatHistory = new ChatHistory(plugin.app, plugin.settings.historyFolder);
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Anthracite Chat';
  }

  getIcon(): string {
    return 'message-circle';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('anthracite-chat-container');

    // Header bar with context info and new chat button
    const header = container.createDiv({ cls: 'anthracite-header' });
    this.contextBanner = header.createDiv({ cls: 'anthracite-context-banner' });
    this.updateContextBanner();

    const newChatBtn = header.createEl('button', {
      cls: 'anthracite-new-chat-button clickable-icon',
      attr: { 'aria-label': 'New chat' },
    });
    setIcon(newChatBtn, 'plus');
    newChatBtn.addEventListener('click', () => this.clearChat());

    const splitChatBtn = header.createEl('button', {
      cls: 'anthracite-new-chat-button clickable-icon',
      attr: { 'aria-label': 'Split chat (new topic)' },
    });
    setIcon(splitChatBtn, 'scissors');
    splitChatBtn.addEventListener('click', () => this.splitChat());

    this.messagesContainer = container.createDiv({ cls: 'anthracite-messages' });

    const inputArea = container.createDiv({ cls: 'anthracite-input-area' });

    this.textarea = inputArea.createEl('textarea', {
      attr: { placeholder: 'Ask Anthracite anything...', rows: '1' },
    });

    this.textarea.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    this.textarea.addEventListener('input', () => {
      this.textarea.style.height = 'auto';
      this.textarea.style.height = Math.min(this.textarea.scrollHeight, 120) + 'px';
    });

    this.sendButton = inputArea.createEl('button', {
      text: 'Send',
      cls: 'anthracite-send-button',
    });
    this.sendButton.addEventListener('click', () => this.sendMessage());

    // Image drop zone
    const dropZone = container;
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.addClass('anthracite-drag-over');
    });
    dropZone.addEventListener('dragleave', () => dropZone.removeClass('anthracite-drag-over'));
    dropZone.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      dropZone.removeClass('anthracite-drag-over');
      this.handleFileDrop(e);
    });

    // Image paste
    this.textarea.addEventListener('paste', (e) => this.handlePaste(e));

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => this.updateContextBanner())
    );
  }

  private updateContextBanner(): void {
    const file = this.app.workspace.getActiveFile();
    const model = CLAUDE_MODELS.find((m) => m.id === this.plugin.settings.modelId);
    const modelTag = model ? ` | ${model.name}` : '';
    const mode = this.plugin.settings.agentMode ? ' | Agent' : '';
    const thinking = this.plugin.settings.extendedThinking ? ' | Thinking' : '';
    this.contextBanner.setText(
      file ? `${file.basename}${modelTag}${mode}${thinking}` : `No note${modelTag}${mode}${thinking}`
    );
  }

  private async sendMessage(): Promise<void> {
    const text = this.textarea.value.trim();
    if (!text || this.isStreaming) return;

    if (!this.plugin.apiKey) {
      this.addErrorMessage('Please set your Claude API key in Settings > Anthracite.');
      return;
    }

    this.client = new ClaudeClient(this.plugin.apiKey);

    const images = this.pendingImages.length > 0 ? [...this.pendingImages] : undefined;
    this.messages.push({ role: 'user', content: text, images });
    this.renderMessage({ role: 'user', content: text, images });

    // Auto-save: start session if needed, save user message
    const activeFile = this.app.workspace.getActiveFile();
    if (!this.chatHistory.getCurrentFilePath()) {
      await this.chatHistory.startSession(activeFile?.basename);
    }

    // Show chat title in header
    const chatFile = this.chatHistory.getCurrentFilePath();
    if (chatFile) {
      this.contextBanner.setText(`Chat: ${activeFile?.basename || 'General Chat'}`);
    }

    await this.chatHistory.appendUserMessage(text);

    // Reset per-message metadata collectors
    this.currentThinking = '';
    this.currentToolCalls = [];
    this.thinkingAutoCollapsed = false;

    // Clear input and pending images
    this.pendingImages = [];
    this.textarea.value = '';
    this.textarea.style.height = 'auto';
    this.containerEl.querySelector('.anthracite-image-previews')?.remove();

    // Build smart context from vault
    const context = await this.contextBuilder.buildContext(activeFile);

    if (context.notes.length > 0) {
      const names = context.notes.map((n) => n.title);
      const display =
        names.length <= 3
          ? names.join(', ')
          : `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;
      this.contextBanner.setText(
        `Context: ${display} (~${Math.round(context.totalTokens / 1000)}k tokens)`
      );
    }

    const noteContext = this.contextBuilder.formatForPrompt(context);

    // Create thinking block FIRST (above response) if enabled
    if (this.plugin.settings.extendedThinking) {
      this.thinkingContainer = this.createThinkingBlock();
      this.thinkingContainer.addClass('anthracite-thinking-expanded'); // Start expanded
    }

    const assistantEl = this.createAssistantBubble();
    this.isStreaming = true;
    this.sendButton.disabled = true;

    const executor = this.plugin.settings.agentMode ? this.toolExecutor : undefined;

    // Load custom system prompt from vault note if configured
    const customPrompt = await this.loadCustomSystemPrompt();

    await this.client.streamChat(
      this.messages,
      noteContext || null,
      {
        onText: (text) => {
          // Auto-collapse thinking when response text starts arriving
          if (!this.thinkingAutoCollapsed && this.thinkingContainer) {
            this.thinkingContainer.removeClass('anthracite-thinking-expanded');
            this.thinkingAutoCollapsed = true;
          }
          assistantEl.empty();
          MarkdownRenderer.render(this.app, text, assistantEl, '', this.plugin);
          assistantEl.addClass('anthracite-streaming-cursor');
          this.scrollToBottom();
        },
        onThinking: (thinking) => {
          this.currentThinking = thinking;
          if (this.thinkingContainer) {
            const content = this.thinkingContainer.querySelector('.anthracite-thinking-content');
            if (content) content.textContent = thinking;
            this.scrollToBottom();
          }
        },
        onToolUse: (toolName, input) => {
          this.currentToolCalls.push({ name: toolName, input, result: '' });
          this.renderToolUse(toolName, input);
        },
        onToolResult: (toolName, result) => {
          const lastCall = this.currentToolCalls[this.currentToolCalls.length - 1];
          if (lastCall) lastCall.result = result;
          this.renderToolResult(toolName, result);
        },
        onDone: (fullText) => {
          this.messages.push({ role: 'assistant', content: fullText });
          assistantEl.removeClass('anthracite-streaming-cursor');
          this.isStreaming = false;
          this.sendButton.disabled = false;
          this.thinkingContainer = null;
          this.textarea.focus();

          // Auto-save assistant message with metadata
          this.chatHistory.appendAssistantMessage(
            fullText,
            this.currentThinking || undefined,
            this.currentToolCalls.length > 0 ? this.currentToolCalls : undefined
          );
        },
        onError: (error) => {
          assistantEl.remove();
          this.thinkingContainer?.remove();
          this.thinkingContainer = null;
          this.addErrorMessage(`Error: ${error.message}`);
          this.isStreaming = false;
          this.sendButton.disabled = false;
        },
      },
      this.plugin.settings.extendedThinking,
      executor,
      this.plugin.settings.maxToolCalls,
      this.plugin.settings.modelId,
      customPrompt
    );
  }

  private renderMessage(msg: ChatMessage): void {
    const cls = msg.role === 'user' ? 'anthracite-message-user' : 'anthracite-message-assistant';
    const el = this.messagesContainer.createDiv({ cls: `anthracite-message ${cls}` });

    if (msg.role === 'assistant') {
      MarkdownRenderer.render(this.app, msg.content, el, '', this.plugin);
    } else {
      if (msg.images && msg.images.length > 0) {
        el.createDiv({ cls: 'anthracite-image-indicator', text: `[${msg.images.length} image${msg.images.length > 1 ? 's' : ''} attached]` });
      }
      el.createSpan({ text: msg.content });
    }

    this.scrollToBottom();
  }

  private renderToolUse(toolName: string, input: Record<string, unknown>): void {
    const el = this.messagesContainer.createDiv({ cls: 'anthracite-tool-use' });
    const summary = Object.values(input).join(', ');
    el.setText(`Using ${toolName}: ${summary}`);
    this.scrollToBottom();
  }

  private renderToolResult(toolName: string, result: string): void {
    const el = this.messagesContainer.createDiv({ cls: 'anthracite-tool-result' });
    const truncated = result.length > 200 ? result.slice(0, 200) + '...' : result;
    el.setText(`${toolName} result: ${truncated}`);
    this.scrollToBottom();
  }

  private createAssistantBubble(): HTMLElement {
    return this.messagesContainer.createDiv({
      cls: 'anthracite-message anthracite-message-assistant',
    });
  }

  private createThinkingBlock(): HTMLElement {
    const wrapper = this.messagesContainer.createDiv({ cls: 'anthracite-thinking-block' });
    const toggle = wrapper.createDiv({ cls: 'anthracite-thinking-toggle' });
    toggle.setText('Claude\'s Thinking');
    toggle.addEventListener('click', () => {
      wrapper.toggleClass('anthracite-thinking-expanded', !wrapper.hasClass('anthracite-thinking-expanded'));
    });
    wrapper.createDiv({ cls: 'anthracite-thinking-content' });
    return wrapper;
  }

  private addErrorMessage(text: string): void {
    const el = this.messagesContainer.createDiv({
      cls: 'anthracite-message anthracite-message-assistant',
    });
    el.style.color = 'var(--text-error)';
    el.setText(text);
    this.scrollToBottom();
  }

  private setupBackupReminder(): void {
    if (this.plugin.settings.backupReminderDismissed) {
      this.toolExecutor.onBeforeFirstWrite = null;
      return;
    }
    this.toolExecutor.onBeforeFirstWrite = () => {
      return new Promise((resolve) => {
        new BackupReminderModal(this.plugin.app, async (result) => {
          if (result.dismiss) {
            this.plugin.settings.backupReminderDismissed = true;
            await this.plugin.saveSettings();
          }
          resolve(result.proceed);
        }).open();
      });
    };
  }

  private clearChat(): void {
    this.client?.abort();
    this.messages = [];
    this.pendingImages = [];
    this.messagesContainer.empty();
    this.thinkingContainer = null;
    this.thinkingAutoCollapsed = false;
    this.isStreaming = false;
    this.sendButton.disabled = false;
    this.updateContextBanner();
    this.textarea.focus();

    // Start fresh history and reset tool trust for next chat
    this.chatHistory = new ChatHistory(this.plugin.app, this.plugin.settings.historyFolder);
    this.toolExecutor.resetTrust();
    this.setupBackupReminder();
  }

  private async splitChat(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    const contextName = activeFile?.basename || 'General Chat';
    await this.chatHistory.startSession(contextName);
    this.contextBanner.setText(`Chat: ${contextName} (continued)`);
    new Notice('Chat split — new messages will save to a new file.');
  }

  private handleFileDrop(e: DragEvent): void {
    const files = e.dataTransfer?.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      this.processImageFile(files[i]);
    }
  }

  private handlePaste(e: ClipboardEvent): void {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) this.processImageFile(file);
      }
    }
  }

  private processImageFile(file: File): void {
    const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      this.addErrorMessage(`Unsupported image type: ${file.type}. Use JPEG, PNG, GIF, or WebP.`);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1];
      this.pendingImages.push({ base64, mediaType: file.type });
      this.showImagePreview(file.name);
    };
    reader.readAsDataURL(file);
  }

  private showImagePreview(filename: string): void {
    // Show a small indicator near the input
    const existing = this.containerEl.querySelector('.anthracite-image-previews');
    const container = existing ?? this.containerEl.querySelector('.anthracite-input-area')?.createDiv({ cls: 'anthracite-image-previews' });
    if (!container) return;

    const chip = (container as HTMLElement).createDiv({ cls: 'anthracite-image-chip' });
    chip.setText(filename);
    const removeBtn = chip.createEl('span', { cls: 'anthracite-image-chip-remove', text: ' x' });
    removeBtn.addEventListener('click', () => {
      const idx = Array.from(container.children).indexOf(chip);
      if (idx >= 0) this.pendingImages.splice(idx, 1);
      chip.remove();
      if (container.children.length === 0) container.remove();
    });
  }

  private async loadCustomSystemPrompt(): Promise<string | undefined> {
    const path = this.plugin.settings.systemPromptPath;
    if (!path) return undefined;

    // Try with and without .md extension
    const tryPaths = path.endsWith('.md') ? [path] : [`${path}.md`, path];
    for (const p of tryPaths) {
      const file = this.app.vault.getAbstractFileByPath(p);
      if (file && 'extension' in file) {
        const content = await this.app.vault.read(file as import('obsidian').TFile);
        if (content.trim()) return content.trim();
      }
    }

    return undefined;
  }

  sendPrefilled(text: string): void {
    this.textarea.value = text;
    this.sendMessage();
  }

  private scrollToBottom(): void {
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  async onClose(): Promise<void> {
    this.client?.abort();
  }
}
