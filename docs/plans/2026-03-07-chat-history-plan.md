# Chat History Persistence — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Auto-save chat conversations as Markdown files in the vault with configurable folder location, using Obsidian callouts for thinking/tool metadata.

**Architecture:** A `ChatHistory` class manages file creation and appending. It formats messages as Markdown with H2 role headers, Obsidian callouts for thinking/tools, and YAML frontmatter. ChatView calls it after each completed message exchange. A new `historyFolder` setting controls the storage location.

**Tech Stack:** TypeScript, Obsidian Vault API (create, modify, append), Obsidian FolderSuggest pattern

---

### Task 1: Add historyFolder Setting

**Files:**
- Modify: `src/settings.ts:4-14` (interface + defaults)
- Modify: `src/settings.ts:102-127` (settings UI, add folder input before Extended Thinking toggle)

**Step 1: Add historyFolder to settings interface and defaults**

In `src/settings.ts`, add `historyFolder` to the interface (line 7) and defaults (line 13):

```typescript
export interface ScribeSettings {
  apiKeySecretName: string;
  extendedThinking: boolean;
  agentMode: boolean;
  historyFolder: string;
}

export const DEFAULT_SETTINGS: ScribeSettings = {
  apiKeySecretName: '',
  extendedThinking: false,
  agentMode: false,
  historyFolder: 'Scribe/History',
};
```

**Step 2: Add folder setting to the UI**

In `src/settings.ts`, add a new Setting between the Test Connection button (ends line 102) and the Extended Thinking toggle (starts line 104):

```typescript
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
```

**Step 3: Build and verify**

Run: `cd <project-root> && npm run build`
Expected: Clean compile

**Step 4: Commit**

```bash
cd <project-root>
git add src/settings.ts
git commit -m "Add historyFolder setting for chat persistence"
```

---

### Task 2: Create ChatHistory Class

**Files:**
- Create: `src/chat-history.ts`

**Step 1: Create the ChatHistory class**

This class handles all file operations for chat persistence. It creates the history folder, generates filenames from timestamps and context, and formats messages as Markdown with YAML frontmatter.

```typescript
import { App, TFile, TFolder, normalizePath } from 'obsidian';

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

  /** Start a new chat session. Call this when the user clicks "New Chat" or sends the first message. */
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
      // Indent each line for the callout block
      const indented = thinking.split('\n').map((line) => `> ${line}`).join('\n');
      text += `\n> [!tip]- Thinking\n${indented}\n`;
    }

    if (toolCalls) {
      for (const tool of toolCalls) {
        const inputStr = Object.entries(tool.input)
          .map(([k, v]) => `> **${k}:** ${String(v)}`)
          .join('\n');
        const resultTruncated =
          tool.result.length > 500 ? tool.result.slice(0, 500) + '...' : tool.result;
        const resultIndented = resultTruncated.split('\n').map((line) => `> ${line}`).join('\n');
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
    // Ensure folder exists
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
```

**Step 2: Build and verify**

Run: `cd <project-root> && npm run build`
Expected: Clean compile

**Step 3: Commit**

```bash
cd <project-root>
git add src/chat-history.ts
git commit -m "Add ChatHistory class for Markdown-based chat persistence"
```

---

### Task 3: Integrate ChatHistory into ChatView

This is the integration task — wire `ChatHistory` into the existing chat flow so messages auto-save.

**Files:**
- Modify: `src/chat-view.ts`

**Step 1: Add ChatHistory import and field**

At top of `src/chat-view.ts`, add import (line 1 area):

```typescript
import { ChatHistory } from './chat-history';
```

Add field to the ChatView class (after line 21, the `pendingImages` field):

```typescript
  private chatHistory: ChatHistory;
  private currentThinking: string = '';
  private currentToolCalls: { name: string; input: Record<string, unknown>; result: string }[] = [];
```

**Step 2: Initialize ChatHistory in constructor**

In the constructor (line 23-28), add after `this.toolExecutor`:

```typescript
    this.chatHistory = new ChatHistory(plugin.app, plugin.settings.historyFolder);
```

**Step 3: Start session and save user message in sendMessage()**

In `sendMessage()` (starts line 116), add session start and user save.

After `this.messages.push(...)` (line 128), add:

```typescript
    // Auto-save: start session if needed, save user message
    const contextName = activeFile?.basename;
    if (!this.chatHistory.getCurrentFilePath()) {
      await this.chatHistory.startSession(contextName);
    }
    await this.chatHistory.appendUserMessage(text);

    // Reset per-message metadata collectors
    this.currentThinking = '';
    this.currentToolCalls = [];
```

Note: `activeFile` is already declared at line 138. Move the `const activeFile = ...` line up before the chatHistory calls, or use the already-pushed message. The simplest fix is to declare `activeFile` earlier — move line 138 (`const activeFile = this.app.workspace.getActiveFile()`) to just after line 128.

**Step 4: Capture thinking and tool data in stream callbacks**

In the `onThinking` callback (line 174), add capture:

```typescript
        onThinking: (thinking) => {
          this.currentThinking = thinking;
          // existing UI code...
        },
```

In the `onToolUse` callback (line 181), capture input:

```typescript
        onToolUse: (toolName, input) => {
          this.currentToolCalls.push({ name: toolName, input, result: '' });
          this.renderToolUse(toolName, input);
        },
```

In the `onToolResult` callback (line 184), capture result:

```typescript
        onToolResult: (toolName, result) => {
          const lastCall = this.currentToolCalls[this.currentToolCalls.length - 1];
          if (lastCall) lastCall.result = result;
          this.renderToolResult(toolName, result);
        },
```

**Step 5: Save assistant message in onDone callback**

In the `onDone` callback (line 187), add auto-save after the existing code:

```typescript
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
```

**Step 6: Reset ChatHistory on clearChat()**

In `clearChat()` (line 265), add a new ChatHistory instance to start fresh:

```typescript
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
```

**Step 7: Build and verify**

Run: `cd <project-root> && npm run build`
Expected: Clean compile

**Step 8: Commit**

```bash
cd <project-root>
git add src/chat-view.ts
git commit -m "Integrate ChatHistory auto-save into chat view"
```

---

### Task 4: Build, Test in Obsidian, Push

**Step 1: Full build**

Run: `cd <project-root> && npm run build`

**Step 2: Manual test checklist**

In Obsidian (AI Overlords vault):
1. Open Scribe settings → verify "Chat History Folder" setting appears with default "Scribe/History"
2. Open Scribe chat → send a message → check that `Scribe/History/` folder is created with a `.md` file
3. Open the saved file → verify frontmatter, H2 headers, user and assistant content
4. Enable Extended Thinking → send a message → verify `> [!tip]- Thinking` callout appears in saved file
5. Enable Agent Mode → ask Claude to search vault → verify `> [!example]- Tool:` callout appears
6. Click "New Chat" → send another message → verify a second file is created
7. Change history folder in settings → verify new chats save to the new location

**Step 3: Push to GitHub**

```bash
cd <project-root> && git push
```
