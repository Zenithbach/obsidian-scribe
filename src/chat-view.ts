import { ItemView, MarkdownRenderer, WorkspaceLeaf, setIcon } from 'obsidian';
import type ScribePlugin from './main';
import { ChatMessage, ClaudeClient, ImageAttachment } from './claude-client';
import { ContextBuilder } from './context-builder';
import { VaultToolExecutor } from './vault-tools';
import { ChatHistory } from './chat-history';

export const CHAT_VIEW_TYPE = 'scribe-chat-view';

export class ChatView extends ItemView {
  plugin: ScribePlugin;
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

  constructor(leaf: WorkspaceLeaf, plugin: ScribePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.contextBuilder = new ContextBuilder(plugin.app);
    this.toolExecutor = new VaultToolExecutor(plugin.app);
    this.chatHistory = new ChatHistory(plugin.app, plugin.settings.historyFolder);
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Scribe Chat';
  }

  getIcon(): string {
    return 'message-circle';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('scribe-chat-container');

    // Header bar with context info and new chat button
    const header = container.createDiv({ cls: 'scribe-header' });
    this.contextBanner = header.createDiv({ cls: 'scribe-context-banner' });
    this.updateContextBanner();

    const newChatBtn = header.createEl('button', {
      cls: 'scribe-new-chat-button clickable-icon',
      attr: { 'aria-label': 'New chat' },
    });
    setIcon(newChatBtn, 'plus');
    newChatBtn.addEventListener('click', () => this.clearChat());

    this.messagesContainer = container.createDiv({ cls: 'scribe-messages' });

    const inputArea = container.createDiv({ cls: 'scribe-input-area' });

    this.textarea = inputArea.createEl('textarea', {
      attr: { placeholder: 'Ask Scribe anything...', rows: '1' },
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
      cls: 'scribe-send-button',
    });
    this.sendButton.addEventListener('click', () => this.sendMessage());

    // Image drop zone
    const dropZone = container;
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.addClass('scribe-drag-over');
    });
    dropZone.addEventListener('dragleave', () => dropZone.removeClass('scribe-drag-over'));
    dropZone.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      dropZone.removeClass('scribe-drag-over');
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
    const mode = this.plugin.settings.agentMode ? ' | Agent' : '';
    const thinking = this.plugin.settings.extendedThinking ? ' | Thinking' : '';
    this.contextBanner.setText(
      file ? `Context: ${file.basename}${mode}${thinking}` : `No note selected${mode}${thinking}`
    );
  }

  private async sendMessage(): Promise<void> {
    const text = this.textarea.value.trim();
    if (!text || this.isStreaming) return;

    if (!this.plugin.apiKey) {
      this.addErrorMessage('Please set your Claude API key in Settings > Obsidian Scribe.');
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
    await this.chatHistory.appendUserMessage(text);

    // Reset per-message metadata collectors
    this.currentThinking = '';
    this.currentToolCalls = [];

    // Clear input and pending images
    this.pendingImages = [];
    this.textarea.value = '';
    this.textarea.style.height = 'auto';
    this.containerEl.querySelector('.scribe-image-previews')?.remove();

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

    const assistantEl = this.createAssistantBubble();
    this.isStreaming = true;
    this.sendButton.disabled = true;

    if (this.plugin.settings.extendedThinking) {
      this.thinkingContainer = this.createThinkingBlock();
    }

    const executor = this.plugin.settings.agentMode ? this.toolExecutor : undefined;

    await this.client.streamChat(
      this.messages,
      noteContext || null,
      {
        onText: (text) => {
          assistantEl.empty();
          MarkdownRenderer.render(this.app, text, assistantEl, '', this.plugin);
          assistantEl.addClass('scribe-streaming-cursor');
          this.scrollToBottom();
        },
        onThinking: (thinking) => {
          this.currentThinking = thinking;
          if (this.thinkingContainer) {
            const content = this.thinkingContainer.querySelector('.scribe-thinking-content');
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
          assistantEl.removeClass('scribe-streaming-cursor');
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
      executor
    );
  }

  private renderMessage(msg: ChatMessage): void {
    const cls = msg.role === 'user' ? 'scribe-message-user' : 'scribe-message-assistant';
    const el = this.messagesContainer.createDiv({ cls: `scribe-message ${cls}` });

    if (msg.role === 'assistant') {
      MarkdownRenderer.render(this.app, msg.content, el, '', this.plugin);
    } else {
      if (msg.images && msg.images.length > 0) {
        el.createDiv({ cls: 'scribe-image-indicator', text: `[${msg.images.length} image${msg.images.length > 1 ? 's' : ''} attached]` });
      }
      el.createSpan({ text: msg.content });
    }

    this.scrollToBottom();
  }

  private renderToolUse(toolName: string, input: Record<string, unknown>): void {
    const el = this.messagesContainer.createDiv({ cls: 'scribe-tool-use' });
    const summary = Object.values(input).join(', ');
    el.setText(`Using ${toolName}: ${summary}`);
    this.scrollToBottom();
  }

  private renderToolResult(toolName: string, result: string): void {
    const el = this.messagesContainer.createDiv({ cls: 'scribe-tool-result' });
    const truncated = result.length > 200 ? result.slice(0, 200) + '...' : result;
    el.setText(`${toolName} result: ${truncated}`);
    this.scrollToBottom();
  }

  private createAssistantBubble(): HTMLElement {
    return this.messagesContainer.createDiv({
      cls: 'scribe-message scribe-message-assistant',
    });
  }

  private createThinkingBlock(): HTMLElement {
    const wrapper = this.messagesContainer.createDiv({ cls: 'scribe-thinking-block' });
    const toggle = wrapper.createDiv({ cls: 'scribe-thinking-toggle' });
    toggle.setText('Thinking...');
    toggle.addEventListener('click', () => {
      wrapper.toggleClass('scribe-thinking-expanded', !wrapper.hasClass('scribe-thinking-expanded'));
    });
    wrapper.createDiv({ cls: 'scribe-thinking-content' });
    return wrapper;
  }

  private addErrorMessage(text: string): void {
    const el = this.messagesContainer.createDiv({
      cls: 'scribe-message scribe-message-assistant',
    });
    el.style.color = 'var(--text-error)';
    el.setText(text);
    this.scrollToBottom();
  }

  private clearChat(): void {
    this.client?.abort();
    this.messages = [];
    this.pendingImages = [];
    this.messagesContainer.empty();
    this.thinkingContainer = null;
    this.isStreaming = false;
    this.sendButton.disabled = false;
    this.updateContextBanner();
    this.textarea.focus();

    // Start fresh history for next chat
    this.chatHistory = new ChatHistory(this.plugin.app, this.plugin.settings.historyFolder);
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
    const existing = this.containerEl.querySelector('.scribe-image-previews');
    const container = existing ?? this.containerEl.querySelector('.scribe-input-area')?.createDiv({ cls: 'scribe-image-previews' });
    if (!container) return;

    const chip = (container as HTMLElement).createDiv({ cls: 'scribe-image-chip' });
    chip.setText(filename);
    const removeBtn = chip.createEl('span', { cls: 'scribe-image-chip-remove', text: ' x' });
    removeBtn.addEventListener('click', () => {
      const idx = Array.from(container.children).indexOf(chip);
      if (idx >= 0) this.pendingImages.splice(idx, 1);
      chip.remove();
      if (container.children.length === 0) container.remove();
    });
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
