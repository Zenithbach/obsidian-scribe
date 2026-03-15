import { ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import type AnthracitePlugin from './main';
import { ChatMessage, ClaudeClient, ImageAttachment, TokenUsage } from './claude-client';
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
  private sessionUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  private tokenDisplay: HTMLElement;

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
    this.showWelcome();

    // Session token counter
    this.tokenDisplay = container.createDiv({ cls: 'anthracite-token-display' });
    this.updateTokenDisplay();

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

    // Drop zone with overlay
    const dropOverlay = container.createDiv({ cls: 'anthracite-drop-overlay' });
    const dropIcon = dropOverlay.createDiv({ cls: 'anthracite-drop-icon' });
    setIcon(dropIcon, 'image-plus');
    dropOverlay.createDiv({ cls: 'anthracite-drop-text', text: 'Drop image or PDF' });

    const dropZone = container;
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.addClass('anthracite-drag-over');
    });
    dropZone.addEventListener('dragleave', (e: DragEvent) => {
      // Only remove if leaving the container entirely
      if (!dropZone.contains(e.relatedTarget as Node)) {
        dropZone.removeClass('anthracite-drag-over');
      }
    });
    dropZone.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      dropZone.removeClass('anthracite-drag-over');
      this.handleFileDrop(e);
    });

    // Image paste
    this.textarea.addEventListener('paste', (e) => this.handlePaste(e));

    // Escape to stop streaming
    container.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.isStreaming) {
        this.stopStreaming();
      }
    });

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

    if (text.length > 100000) {
      new Notice('Message too long (max 100,000 characters).');
      return;
    }

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

    // Wrapper groups the response + thinking block together
    const messageGroup = this.messagesContainer.createDiv({ cls: 'anthracite-message-group' });

    // Create response bubble first (order: 1 via CSS)
    const assistantEl = messageGroup.createDiv({
      cls: 'anthracite-message anthracite-message-assistant',
    });

    // Show typing indicator until content arrives
    const typingIndicator = assistantEl.createDiv({ cls: 'anthracite-typing-indicator' });
    for (let i = 0; i < 3; i++) typingIndicator.createSpan({ cls: 'anthracite-typing-dot' });

    // Create thinking block below response (order: 2 via CSS)
    if (this.plugin.settings.extendedThinking) {
      this.thinkingContainer = this.createThinkingBlock(messageGroup);
      this.thinkingContainer.addClass('anthracite-thinking-expanded');
    }
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
          sanitizeRenderedHtml(assistantEl);
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
        onUsage: (usage) => {
          this.sessionUsage.inputTokens += usage.inputTokens;
          this.sessionUsage.outputTokens += usage.outputTokens;
          this.updateTokenDisplay();
          this.renderTokenBadge(messageGroup, usage);
        },
        onDone: (fullText) => {
          this.messages.push({ role: 'assistant', content: fullText });
          assistantEl.removeClass('anthracite-streaming-cursor');
          this.isStreaming = false;
          this.sendButton.disabled = false;
          this.thinkingContainer = null;
          this.textarea.focus();

          // Add copy buttons to code blocks and message actions
          this.addCodeCopyButtons(assistantEl);
          this.addMessageActions(messageGroup, fullText);

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
          this.addErrorMessage(this.friendlyError(error));
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
    const wrapper = this.messagesContainer.createDiv({ cls: `anthracite-message-wrapper` });
    const el = wrapper.createDiv({ cls: `anthracite-message ${cls}` });

    if (msg.role === 'assistant') {
      MarkdownRenderer.render(this.app, msg.content, el, '', this.plugin);
      sanitizeRenderedHtml(el);
      this.addCodeCopyButtons(el);
    } else {
      if (msg.images && msg.images.length > 0) {
        const gallery = el.createDiv({ cls: 'anthracite-message-images' });
        for (const img of msg.images) {
          if (img.mediaType === 'application/pdf') {
            const pdfChip = gallery.createDiv({ cls: 'anthracite-pdf-badge' });
            const icon = pdfChip.createSpan({ cls: 'anthracite-file-icon' });
            setIcon(icon, 'file-text');
            pdfChip.createSpan({ text: 'PDF' });
          } else {
            gallery.createEl('img', {
              cls: 'anthracite-message-image',
              attr: { src: `data:${img.mediaType};base64,${img.base64}` },
            });
          }
        }
      }
      el.createSpan({ text: msg.content });
    }

    this.addMessageActions(wrapper, msg.content);
    this.scrollToBottom();
  }

  private addCodeCopyButtons(el: HTMLElement): void {
    const codeBlocks = el.querySelectorAll('pre > code');
    for (const code of Array.from(codeBlocks)) {
      const pre = code.parentElement;
      if (!pre || pre.querySelector('.anthracite-code-copy')) continue;
      pre.addClass('anthracite-code-pre');
      const btn = pre.createEl('button', {
        cls: 'anthracite-code-copy clickable-icon',
        attr: { 'aria-label': 'Copy code' },
      });
      setIcon(btn, 'copy');
      btn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(code.textContent || '');
        setIcon(btn, 'check');
        setTimeout(() => setIcon(btn, 'copy'), 1500);
      });
    }
  }

  private addMessageActions(wrapper: HTMLElement, content: string): void {
    const actions = wrapper.createDiv({ cls: 'anthracite-message-actions' });

    const copyBtn = actions.createEl('button', {
      cls: 'anthracite-action-btn clickable-icon',
      attr: { 'aria-label': 'Copy message' },
    });
    setIcon(copyBtn, 'copy');
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(content);
      new Notice('Copied to clipboard');
    });
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

  private createThinkingBlock(parent?: HTMLElement): HTMLElement {
    const wrapper = (parent || this.messagesContainer).createDiv({ cls: 'anthracite-thinking-block' });
    const toggle = wrapper.createDiv({ cls: 'anthracite-thinking-toggle' });
    const chevron = toggle.createSpan({ cls: 'anthracite-thinking-chevron' });
    setIcon(chevron, 'chevron-right');
    toggle.createSpan({ text: 'Claude\'s Thinking' });
    toggle.addEventListener('click', () => {
      wrapper.toggleClass('anthracite-thinking-expanded', !wrapper.hasClass('anthracite-thinking-expanded'));
    });
    wrapper.createDiv({ cls: 'anthracite-thinking-content' });
    return wrapper;
  }

  private formatTokenCount(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
  }

  private updateTokenDisplay(): void {
    if (this.sessionUsage.inputTokens === 0 && this.sessionUsage.outputTokens === 0) {
      this.tokenDisplay.style.display = 'none';
      return;
    }
    this.tokenDisplay.style.display = '';
    const total = this.sessionUsage.inputTokens + this.sessionUsage.outputTokens;
    this.tokenDisplay.setText(
      `Session: ${this.formatTokenCount(total)} tokens (${this.formatTokenCount(this.sessionUsage.inputTokens)} in / ${this.formatTokenCount(this.sessionUsage.outputTokens)} out)`
    );
  }

  private renderTokenBadge(parent: HTMLElement, usage: TokenUsage): void {
    const total = usage.inputTokens + usage.outputTokens;
    parent.createDiv({
      cls: 'anthracite-token-badge',
      text: `${this.formatTokenCount(total)} tokens`,
    });
  }

  private friendlyError(error: Error): string {
    const msg = error.message || '';
    if (msg.includes('prompt is too long')) {
      return 'The conversation is too long for Claude to process. Try starting a new chat, or remove large attachments.';
    }
    if (msg.includes('invalid_api_key') || msg.includes('authentication')) {
      return 'Invalid API key. Check your key in Settings > Anthracite.';
    }
    if (msg.includes('rate_limit') || msg.includes('429')) {
      return 'Rate limited — too many requests. Wait a moment and try again.';
    }
    if (msg.includes('overloaded') || msg.includes('529')) {
      return 'Claude is currently overloaded. Try again in a few seconds.';
    }
    const truncated = msg.length > 200 ? msg.slice(0, 200) + '...' : msg;
    return `Something went wrong. ${truncated}`;
  }

  private addErrorMessage(text: string): void {
    const el = this.messagesContainer.createDiv({
      cls: 'anthracite-message anthracite-message-assistant',
    });
    el.style.color = 'var(--text-error)';
    el.setText(text);
    this.scrollToBottom();
  }

  private showWelcome(): void {
    const welcome = this.messagesContainer.createDiv({ cls: 'anthracite-welcome' });
    const icon = welcome.createDiv({ cls: 'anthracite-welcome-icon' });
    setIcon(icon, 'message-circle');
    welcome.createEl('h3', { text: 'Anthracite' });
    welcome.createEl('p', {
      text: 'Your Claude-powered assistant. Open a note for context-aware chat, or just ask anything.',
      cls: 'anthracite-welcome-subtitle',
    });

    const suggestions = welcome.createDiv({ cls: 'anthracite-suggestions' });
    const prompts = [
      { icon: 'file-text', text: 'Summarize this note', prompt: 'Please summarize this note concisely.' },
      { icon: 'search', text: 'What do I know about...', prompt: 'Search my vault and tell me what I know about ' },
      { icon: 'lightbulb', text: 'Help me brainstorm', prompt: 'Help me brainstorm ideas for ' },
      { icon: 'pen-line', text: 'Help me write', prompt: 'Help me write ' },
    ];

    for (const s of prompts) {
      const chip = suggestions.createDiv({ cls: 'anthracite-suggestion-chip' });
      const chipIcon = chip.createSpan({ cls: 'anthracite-suggestion-icon' });
      setIcon(chipIcon, s.icon);
      chip.createSpan({ text: s.text });
      chip.addEventListener('click', () => {
        this.textarea.value = s.prompt;
        this.textarea.focus();
        // Place cursor at end for prompts that need completion
        this.textarea.selectionStart = this.textarea.selectionEnd = s.prompt.length;
      });
    }
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
    this.showWelcome();
    this.textarea.focus();

    // Start fresh history, reset tool trust and token counter for next chat
    this.chatHistory = new ChatHistory(this.plugin.app, this.plugin.settings.historyFolder);
    this.toolExecutor.resetTrust();
    this.setupBackupReminder();
    this.sessionUsage = { inputTokens: 0, outputTokens: 0 };
    this.updateTokenDisplay();
  }

  private async splitChat(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    const contextName = activeFile?.basename || 'General Chat';
    await this.chatHistory.startSession(contextName);
    this.contextBanner.setText(`Chat: ${contextName} (continued)`);
    new Notice('Chat split — new messages will save to a new file.');
  }

  private handleFileDrop(e: DragEvent): void {
    // Check for Obsidian internal file drag (from file explorer)
    const internalPath = e.dataTransfer?.getData('text/plain');
    if (internalPath && !e.dataTransfer?.files.length) {
      this.processVaultImage(internalPath);
      return;
    }

    const files = e.dataTransfer?.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      this.processImageFile(files[i]);
    }
  }

  private async processVaultImage(path: string): Promise<void> {
    const validExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf'];
    const ext = path.split('.').pop()?.toLowerCase();
    if (!ext || !validExtensions.includes(ext)) {
      this.addErrorMessage(`Unsupported file type: .${ext || '?'}. Use JPEG, PNG, GIF, WebP, or PDF.`);
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      this.addErrorMessage(`File not found in vault: ${path}`);
      return;
    }

    const buffer = await this.app.vault.readBinary(file);
    const base64 = arrayBufferToBase64(buffer);
    const mimeMap: Record<string, string> = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
    };
    const mediaType = mimeMap[ext];
    this.pendingImages.push({ base64, mediaType });
    this.showImagePreview(file.name, base64, mediaType);
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
    const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
    if (!validTypes.includes(file.type)) {
      this.addErrorMessage(`Unsupported file type: ${file.type}. Use JPEG, PNG, GIF, WebP, or PDF.`);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1];
      this.pendingImages.push({ base64, mediaType: file.type });
      this.showImagePreview(file.name, base64, file.type);
    };
    reader.readAsDataURL(file);
  }

  private showImagePreview(filename: string, base64: string, mediaType: string): void {
    const existing = this.containerEl.querySelector('.anthracite-image-previews');
    const container = existing ?? this.containerEl.querySelector('.anthracite-input-area')?.createDiv({ cls: 'anthracite-image-previews' });
    if (!container) return;

    const chip = (container as HTMLElement).createDiv({ cls: 'anthracite-image-chip' });
    if (mediaType === 'application/pdf') {
      const icon = chip.createSpan({ cls: 'anthracite-file-icon' });
      setIcon(icon, 'file-text');
    } else {
      chip.createEl('img', {
        cls: 'anthracite-image-thumb',
        attr: { src: `data:${mediaType};base64,${base64}`, alt: filename },
      });
    }
    chip.createSpan({ cls: 'anthracite-image-chip-name', text: filename });
    const removeBtn = chip.createSpan({ cls: 'anthracite-image-chip-remove' });
    setIcon(removeBtn, 'x');
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

  /** Start a new chat session (clears messages, resets trust). */
  newChat(): void {
    this.clearChat();
  }

  /** Stop the current streaming response. */
  stopStreaming(): void {
    if (this.isStreaming) {
      this.client?.abort();
      this.isStreaming = false;
      this.sendButton.disabled = false;
    }
  }

  /** Focus the chat input textarea. */
  focusInput(): void {
    this.textarea.focus();
  }

  /** Copy the current conversation to clipboard as Markdown. */
  async exportToClipboard(): Promise<void> {
    if (this.messages.length === 0) {
      new Notice('No messages to export.');
      return;
    }
    const lines = this.messages.map((msg) => {
      const role = msg.role === 'user' ? '**You**' : '**Claude**';
      return `${role}:\n${msg.content}`;
    });
    await navigator.clipboard.writeText(lines.join('\n\n---\n\n'));
    new Notice(`Copied ${this.messages.length} messages to clipboard.`);
  }

  private scrollToBottom(): void {
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  async onClose(): Promise<void> {
    this.client?.abort();
  }
}

function sanitizeRenderedHtml(el: HTMLElement): void {
  // Remove dangerous elements
  el.querySelectorAll('script, iframe, object, embed, form').forEach(n => n.remove());

  // Remove event handler attributes from all elements
  const allElements = Array.from(el.querySelectorAll('*'));
  for (const elem of allElements) {
    const attrs = Array.from(elem.attributes);
    for (const attr of attrs) {
      if (attr.name.startsWith('on') || attr.value.startsWith('javascript:')) {
        elem.removeAttribute(attr.name);
      }
    }
    // Remove javascript: from href/src
    if (elem.hasAttribute('href') && elem.getAttribute('href')?.toLowerCase().startsWith('javascript:')) {
      elem.removeAttribute('href');
    }
    if (elem.hasAttribute('src') && elem.getAttribute('src')?.toLowerCase().startsWith('javascript:')) {
      elem.removeAttribute('src');
    }
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
