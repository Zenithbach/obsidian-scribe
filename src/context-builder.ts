import { App, TFile, CachedMetadata } from 'obsidian';

interface ContextNote {
  path: string;
  title: string;
  content: string;
  reason: string; // Why this note was included
  tokens: number; // Rough estimate
}

export interface BuiltContext {
  notes: ContextNote[];
  totalTokens: number;
  activeNote: string | null;
}

// Rough token estimate: ~4 chars per token for English text
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class ContextBuilder {
  private app: App;
  // Reserve space for system prompt, conversation, and response
  private readonly TOKEN_BUDGET = 80_000;
  private readonly MAX_NOTE_TOKENS = 20_000;

  constructor(app: App) {
    this.app = app;
  }

  async buildContext(activeFile: TFile | null): Promise<BuiltContext> {
    if (!activeFile) {
      return { notes: [], totalTokens: 0, activeNote: null };
    }

    const notes: ContextNote[] = [];
    let totalTokens = 0;
    const visited = new Set<string>();

    // 1. Always include the active note (highest priority)
    const activeContent = await this.app.vault.cachedRead(activeFile);
    const activeTokens = estimateTokens(activeContent);
    const truncatedContent =
      activeTokens > this.MAX_NOTE_TOKENS
        ? activeContent.slice(0, this.MAX_NOTE_TOKENS * 4) + '\n\n[Note truncated]'
        : activeContent;

    notes.push({
      path: activeFile.path,
      title: activeFile.basename,
      content: truncatedContent,
      reason: 'Active note',
      tokens: Math.min(activeTokens, this.MAX_NOTE_TOKENS),
    });
    totalTokens += notes[0].tokens;
    visited.add(activeFile.path);

    // 2. Follow outgoing links from the active note
    const metadata = this.app.metadataCache.getFileCache(activeFile);
    if (metadata) {
      const linkedFiles = this.getLinkedFiles(metadata, activeFile);
      for (const { file, reason } of linkedFiles) {
        if (visited.has(file.path) || totalTokens >= this.TOKEN_BUDGET) break;
        const note = await this.addNote(file, reason, visited);
        if (note) {
          totalTokens += note.tokens;
          notes.push(note);
        }
      }
    }

    // 3. Follow backlinks (notes that link TO the active note)
    const backlinks = this.getBacklinks(activeFile);
    for (const file of backlinks) {
      if (visited.has(file.path) || totalTokens >= this.TOKEN_BUDGET) break;
      const note = await this.addNote(file, `Links to "${activeFile.basename}"`, visited);
      if (note) {
        totalTokens += note.tokens;
        notes.push(note);
      }
    }

    // 4. Notes in the same folder
    const siblings = this.getSiblingFiles(activeFile);
    for (const file of siblings) {
      if (visited.has(file.path) || totalTokens >= this.TOKEN_BUDGET) break;
      const note = await this.addNote(file, 'Same folder', visited);
      if (note) {
        totalTokens += note.tokens;
        notes.push(note);
      }
    }

    return {
      notes,
      totalTokens,
      activeNote: activeFile.basename,
    };
  }

  private getLinkedFiles(
    metadata: CachedMetadata,
    sourceFile: TFile
  ): { file: TFile; reason: string }[] {
    const results: { file: TFile; reason: string }[] = [];

    // Wikilinks and markdown links
    const links = [...(metadata.links ?? []), ...(metadata.embeds ?? [])];
    for (const link of links) {
      const resolved = this.app.metadataCache.getFirstLinkpathDest(link.link, sourceFile.path);
      if (resolved instanceof TFile && resolved.extension === 'md') {
        results.push({ file: resolved, reason: `Linked from "${sourceFile.basename}"` });
      }
    }

    return results;
  }

  private getBacklinks(file: TFile): TFile[] {
    // Use Obsidian's resolved links to find backlinks
    const allFiles = this.app.vault.getMarkdownFiles();
    const backlinks: TFile[] = [];

    for (const candidate of allFiles) {
      const resolved = this.app.metadataCache.resolvedLinks[candidate.path];
      if (resolved && resolved[file.path]) {
        backlinks.push(candidate);
      }
    }

    // Sort by modification time (most recent first)
    return backlinks.sort((a, b) => b.stat.mtime - a.stat.mtime).slice(0, 10);
  }

  private getSiblingFiles(file: TFile): TFile[] {
    const folder = file.parent;
    if (!folder) return [];

    return this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.parent?.path === folder.path && f.path !== file.path)
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, 5);
  }

  private async addNote(
    file: TFile,
    reason: string,
    visited: Set<string>
  ): Promise<ContextNote | null> {
    if (visited.has(file.path)) return null;
    visited.add(file.path);

    const content = await this.app.vault.cachedRead(file);
    const tokens = estimateTokens(content);

    if (tokens === 0) return null;

    const truncated =
      tokens > this.MAX_NOTE_TOKENS
        ? content.slice(0, this.MAX_NOTE_TOKENS * 4) + '\n\n[Note truncated]'
        : content;

    return {
      path: file.path,
      title: file.basename,
      content: truncated,
      reason,
      tokens: Math.min(tokens, this.MAX_NOTE_TOKENS),
    };
  }

  formatForPrompt(context: BuiltContext): string {
    if (context.notes.length === 0) return '';

    const parts: string[] = [];
    for (const note of context.notes) {
      parts.push(`## ${note.title}\n*Path: ${note.path} | Reason: ${note.reason}*\n\n${note.content}`);
    }

    return parts.join('\n\n---\n\n');
  }
}
