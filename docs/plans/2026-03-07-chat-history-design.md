# Chat History Persistence

**Date:** 2026-03-07
**Status:** Approved

## Overview

Save chat conversations as Markdown files in the vault, auto-saving after each message exchange. Uses Obsidian callouts to preserve thinking blocks and tool call metadata in a human-readable format.

## Storage Structure

```
Scribe/                    ← configurable state folder (setting: historyFolder)
  History/
    2026-03-07 10-30 My Research Note.md
    2026-03-07 14-15 General Chat.md
```

Filename: `YYYY-MM-DD HH-mm <context note name or "General Chat">.md`

## Markdown Format

```markdown
---
created: 2026-03-07T10:30:00
context: "My Research Note.md"
tags:
  - scribe-chat
---

# Scribe Chat — My Research Note

## User
What does this note say about AI alignment?

## Assistant
Based on your note, the key points are...

> [!tip]- Thinking
> Let me analyze the structure of this note...

> [!example]- Tool: search_vault
> **Input:** query = "AI alignment"
> **Result:** Found 3 matches in vault

## User
Can you summarize it?

## Assistant
Here's a concise summary...
```

## Settings

- **Chat History Folder** — text input with default `"Scribe/History"`, configurable

## Auto-Save Behavior

- Chat file created when user sends first message
- File updated after Claude's response completes (including thinking/tool blocks)
- "New Chat" starts a new file; old file stays saved
- No previous chat restored on plugin load (clean start)

## Components

1. **`ChatHistory` class** (`src/chat-history.ts`) — file creation, message appending, Markdown formatting
2. **Settings update** — add `historyFolder` field with default
3. **ChatView integration** — call ChatHistory after each message exchange

## Not In Scope

- Reloading/resuming previous chats
- Chat list sidebar or browser
- Searching within chats (Obsidian's built-in search handles this)
- Export/import
