import { App, TFile, normalizePath } from 'obsidian';

interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  toolCalls?: { name: string; input: Record<string, unknown>; result: string }[];
}

export class ChatHistory {
  private app: App;
  private historyFolder: string;
  private currentFile: TFile | null = null;
  private contextName: string = 'General Chat';
  private created: string = '';

  constructor(app: App, historyFolder: string) {
    this.app = app;
    this.historyFolder = historyFolder;
  }

  /** Start a new chat session. Call this when the user sends the first message. */
  async startSession(contextNoteName?: string): Promise<void> {
    this.currentFile = null;
    this.contextName = contextNoteName || 'General Chat';
    this.created = new Date().toISOString();
  }

  /** Append a user message to the current chat file. */
  async appendUserMessage(content: string): Promise<void> {
    const text = `\n## User\n${content}\n`;
    await this.ensureFileAndAppend(text);
  }

  /** Append an assistant message with optional thinking and tool calls. */
  async appendAssistantMessage(
    content: string,
    thinking?: string,
    toolCalls?: { name: string; input: Record<string, unknown>; result: string }[]
  ): Promise<void> {
    let text = `\n## Assistant\n${content}\n`;

    if (thinking) {
      const indented = thinking
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      text += `\n> [!tip]- Thinking\n${indented}\n`;
    }

    if (toolCalls) {
      for (const tool of toolCalls) {
        const inputStr = Object.entries(tool.input)
          .map(([k, v]) => `> **${k}:** ${String(v)}`)
          .join('\n');
        const resultTruncated =
          tool.result.length > 500 ? tool.result.slice(0, 500) + '...' : tool.result;
        const resultIndented = resultTruncated
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n');
        text += `\n> [!example]- Tool: ${tool.name}\n${inputStr}\n> **Result:**\n${resultIndented}\n`;
      }
    }

    await this.ensureFileAndAppend(text);
  }

  /** Get the current file path (for display purposes). */
  getCurrentFilePath(): string | null {
    return this.currentFile?.path ?? null;
  }

  private async ensureFileAndAppend(text: string): Promise<void> {
    if (!this.currentFile) {
      await this.createChatFile();
    }
    if (this.currentFile) {
      await this.app.vault.append(this.currentFile, text);
    }
  }

  private async createChatFile(): Promise<void> {
    // Ensure folder exists (create nested folders if needed)
    const folderPath = normalizePath(this.historyFolder);
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder) {
      await this.app.vault.createFolder(folderPath);
    }

    // Generate filename: "2026-03-07 10-30 Context Name.md"
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const time = `${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}`;
    const safeName = this.contextName.replace(/[\\/:*?"<>|]/g, '-');
    const filename = `${date} ${time} ${safeName}.md`;
    const filePath = normalizePath(`${this.historyFolder}/${filename}`);

    // Create with frontmatter
    const frontmatter = [
      '---',
      `created: ${this.created}`,
      `context: "${this.contextName}"`,
      'tags:',
      '  - scribe-chat',
      '---',
      '',
      `# Scribe Chat — ${this.contextName}`,
      '',
    ].join('\n');

    this.currentFile = await this.app.vault.create(filePath, frontmatter);
  }
}
