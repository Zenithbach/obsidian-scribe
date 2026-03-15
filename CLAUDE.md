# Obsidian Scribe

Claude-native AI assistant plugin for Obsidian.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Development build with watch mode
npm run build        # Production build (TypeScript check + esbuild)
```

## Architecture

Minimal, Claude-native design - no unnecessary abstractions.

```
src/main.ts            → Plugin shell, lifecycle, commands
src/settings.ts        → API key (SecretStorage), feature toggles
src/claude-client.ts   → Streaming + extended thinking + tool use loop
src/chat-view.ts       → Sidebar chat UI with all features integrated
src/context-builder.ts → Smart note selection (backlinks, tags, siblings)
src/vault-tools.ts     → 5 vault tools for agent mode
```

## Key Patterns

- **API key** stored in Obsidian's localStorage (OS keychain equivalent), never in data.json or URL params
- **Context window as database** - 200K tokens replaces RAG/file uploads. ContextBuilder selects relevant notes.
- **Extended thinking** replaces polling-based research APIs
- **Protected paths** - .obsidian/ and state folders are excluded from tool operations
- **YAML frontmatter** respected on all edit operations

## Model

Uses `claude-sonnet-4-20250514`. API calls go to Anthropic only.

## Testing

Symlink into vault: `ln -s <project-root> ~/path-to-vault/.obsidian/plugins/obsidian-anthracite`

## Design Doc

See `docs/plans/2026-03-06-obsidian-scribe-claude-plugin-design.md`
