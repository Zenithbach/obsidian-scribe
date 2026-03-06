import { ItemView, MarkdownRenderer, WorkspaceLeaf } from 'obsidian';
import type ScribePlugin from './main';
import { ChatMessage, ClaudeClient } from './claude-client';

export const CHAT_VIEW_TYPE = 'scribe-chat-view';

export class ChatView extends ItemView {
  plugin: ScribePlugin;
  private messages: ChatMessage[] = [];
  private messagesContainer: HTMLElement;
  private textarea: HTMLTextAreaElement;
  private sendButton: HTMLButtonElement;
  private contextBanner: HTMLElement;
  private client: ClaudeClient | null = null;
  private isStreaming = false;

  constructor(leaf: WorkspaceLeaf, plugin: ScribePlugin) {
    super(leaf);
    this.plugin = plugin;
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

    // Context banner showing current note
    this.contextBanner = container.createDiv({ cls: 'scribe-context-banner' });
    this.updateContextBanner();

    // Messages area
    this.messagesContainer = container.createDiv({ cls: 'scribe-messages' });

    // Input area
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

    // Auto-resize textarea
    this.textarea.addEventListener('input', () => {
      this.textarea.style.height = 'auto';
      this.textarea.style.height = Math.min(this.textarea.scrollHeight, 120) + 'px';
    });

    this.sendButton = inputArea.createEl('button', {
      text: 'Send',
      cls: 'scribe-send-button',
    });
    this.sendButton.addEventListener('click', () => this.sendMessage());

    // Listen for active file changes
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => this.updateContextBanner())
    );
  }

  private updateContextBanner(): void {
    const file = this.app.workspace.getActiveFile();
    this.contextBanner.setText(file ? `Context: ${file.basename}` : 'No note selected');
  }

  private async getActiveNoteContent(): Promise<string | null> {
    const file = this.app.workspace.getActiveFile();
    if (!file) return null;
    return await this.app.vault.cachedRead(file);
  }

  private async sendMessage(): Promise<void> {
    const text = this.textarea.value.trim();
    if (!text || this.isStreaming) return;

    if (!this.plugin.apiKey) {
      this.addErrorMessage('Please set your Claude API key in Settings > Obsidian Scribe.');
      return;
    }

    // Create client on demand (so it picks up key changes)
    this.client = new ClaudeClient(this.plugin.apiKey);

    // Add user message
    this.messages.push({ role: 'user', content: text });
    this.renderMessage({ role: 'user', content: text });

    // Clear input
    this.textarea.value = '';
    this.textarea.style.height = 'auto';

    // Get current note context
    const noteContext = await this.getActiveNoteContent();

    // Create placeholder for assistant response
    const assistantEl = this.createAssistantBubble();
    this.isStreaming = true;
    this.sendButton.disabled = true;

    await this.client.streamChat(this.messages, noteContext, {
      onText: (text) => {
        assistantEl.empty();
        MarkdownRenderer.render(this.app, text, assistantEl, '', this.plugin);
        assistantEl.addClass('scribe-streaming-cursor');
        this.scrollToBottom();
      },
      onDone: (fullText) => {
        this.messages.push({ role: 'assistant', content: fullText });
        assistantEl.removeClass('scribe-streaming-cursor');
        this.isStreaming = false;
        this.sendButton.disabled = false;
        this.textarea.focus();
      },
      onError: (error) => {
        assistantEl.remove();
        this.addErrorMessage(`Error: ${error.message}`);
        this.isStreaming = false;
        this.sendButton.disabled = false;
      },
    });
  }

  private renderMessage(msg: ChatMessage): void {
    const cls = msg.role === 'user' ? 'scribe-message-user' : 'scribe-message-assistant';
    const el = this.messagesContainer.createDiv({ cls: `scribe-message ${cls}` });

    if (msg.role === 'assistant') {
      MarkdownRenderer.render(this.app, msg.content, el, '', this.plugin);
    } else {
      el.setText(msg.content);
    }

    this.scrollToBottom();
  }

  private createAssistantBubble(): HTMLElement {
    return this.messagesContainer.createDiv({
      cls: 'scribe-message scribe-message-assistant',
    });
  }

  private addErrorMessage(text: string): void {
    const el = this.messagesContainer.createDiv({
      cls: 'scribe-message scribe-message-assistant',
    });
    el.style.color = 'var(--text-error)';
    el.setText(text);
    this.scrollToBottom();
  }

  private scrollToBottom(): void {
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  async onClose(): Promise<void> {
    this.client?.abort();
  }
}
