# Obsidian Scribe (Claude Plugin) - Design Document

## Overview

A Claude-native Obsidian plugin for AI-driven assistance. Designed around Claude's specific strengths rather than replicating another provider's architecture. Built iteratively as a showcase of AI-assisted development.

## Core Philosophy

Design every feature around what Claude does differently:

- **200K context window** replaces RAG indexing. Notes are loaded directly into conversation context - no cloud file uploads, no external storage.
- **Extended thinking** replaces polling-based research APIs. Complex analysis happens in a single call with visible reasoning.
- **Native tool use** enables vault operations as first-class tool calls.
- **Privacy by architecture** - API calls go to Anthropic, vault content stays local until sent in a conversation, no files uploaded to cloud storage.

## Architecture

```
Plugin Shell (lifecycle, settings, UI)
  |
  +-- ContextBuilder
  |   Selects relevant notes using Obsidian's metadata cache,
  |   backlinks, tags, and recency. Assembles them into a
  |   context payload that fits the conversation's needs.
  |
  +-- Claude Client
  |   Thin wrapper around @anthropic-ai/sdk.
  |   Handles streaming, extended thinking, and tool use.
  |
  +-- ToolKit
  |   Vault operations (read, write, search, create, list)
  |   exposed as Claude tool definitions with a permission system.
  |
  +-- Views
      Chat panel, Thinking Inspector, inline completions.
```

### Key Architectural Decisions

- **No factory/decorator pattern** - unnecessary abstraction for a single provider. Keep the client simple.
- **No RAG indexing** - the context window replaces it. ContextBuilder does smart selection, not upload.
- **No research polling loops** - extended thinking handles deep analysis in one call.
- **No SDK monkey-patching** - use the Anthropic SDK as designed.

## Security (Built In From Day One)

Informed by a security audit of an existing Obsidian AI plugin:

- API key stored in Obsidian's SecretStorage (OS keychain), never in data.json
- API key sent via HTTP headers only, never in URL parameters
- Private IP/localhost blocklist for any URL fetching features
- No process.env leaking to child processes
- Console logging gated behind debug mode, never logs sensitive data

## Phased Build Plan

Each phase produces a working, installable plugin.

### Phase 1: "It talks"
Chat sidebar that knows your current note.
- Plugin shell: manifest, settings, SecretStorage API key
- Claude client with streaming responses
- Chat view in Obsidian's right sidebar
- Active note sent as context automatically
- Markdown rendering in chat

### Phase 2: "It understands your vault"
Smart context - pulls in related notes automatically.
- ContextBuilder using Obsidian's metadata cache
- Follows backlinks, tags, folder structure to find related notes
- Transparency: user sees which notes were included
- Conversation history within a session

### Phase 3: "It thinks out loud"
Extended thinking with a Thinking Inspector.
- Extended thinking enabled on Claude API calls
- Thinking Inspector panel showing Claude's reasoning process
- Toggle between quick responses and deep thinking
- Unique feature no other Obsidian AI plugin offers

### Phase 4: "It acts"
Agent mode with vault tools.
- ToolKit: read_file, write_file, search, create, list
- Confirmation UI for write/delete operations
- Tool call results rendered inline in chat
- Session persistence (save/load conversations)

### Phase 5: "It sees"
Vision and attachments.
- Drag-and-drop images, PDFs, handwritten notes
- Claude analyzes them in context with vault content
- Inline completions (cursor-level suggestions while writing)

### Phase 6+: Polish and advanced features
- Summaries and rewrites as commands
- MCP server support
- Custom prompts/skills system
- Community plugin submission

## Technical Stack

- **Language:** TypeScript
- **AI SDK:** @anthropic-ai/sdk
- **Build:** esbuild (standard for Obsidian plugins)
- **Tests:** Jest with ts-jest, JSDOM environment
- **Formatting:** Prettier

## What This Is Not

This is not a clone or comparison of any existing plugin. It is a standalone product designed around Claude's capabilities, built iteratively as a demonstration of AI-assisted software development.
