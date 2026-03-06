import { App, TFile, TFolder } from 'obsidian';
import Anthropic from '@anthropic-ai/sdk';

// Tool definitions for Claude's tool_use
export const VAULT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'read_note',
    description:
      'Read the full content of a note in the vault. Returns the markdown content including frontmatter.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Path to the note, e.g. "folder/my-note.md". Extension is optional.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_vault',
    description:
      'Search for notes in the vault by name or content. Returns matching file paths with excerpts.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query - matches against file names and content.',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return. Default 10.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_files',
    description: 'List all files in a folder, or the root of the vault if no path given.',
    input_schema: {
      type: 'object' as const,
      properties: {
        folder: {
          type: 'string',
          description: 'Folder path. Omit for vault root.',
        },
      },
      required: [],
    },
  },
  {
    name: 'create_note',
    description: 'Create a new note in the vault. Will not overwrite existing notes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Path for the new note, e.g. "folder/new-note.md"',
        },
        content: {
          type: 'string',
          description: 'Markdown content for the note.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_note',
    description:
      'Edit an existing note. Can append to, prepend to, or replace the entire content. Respects YAML frontmatter.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Path to the note to edit.',
        },
        content: {
          type: 'string',
          description: 'The content to write.',
        },
        mode: {
          type: 'string',
          enum: ['append', 'prepend', 'replace'],
          description: 'How to apply the edit. Default: append.',
        },
      },
      required: ['path', 'content'],
    },
  },
];

interface ToolResult {
  content: string;
  isError?: boolean;
}

export class VaultToolExecutor {
  private app: App;
  private stateFolder: string;

  constructor(app: App, stateFolder = 'gemini-scribe') {
    this.app = app;
    this.stateFolder = stateFolder;
  }

  async execute(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<ToolResult> {
    try {
      switch (toolName) {
        case 'read_note':
          return await this.readNote(input.path as string);
        case 'search_vault':
          return await this.searchVault(input.query as string, (input.limit as number) ?? 10);
        case 'list_files':
          return await this.listFiles((input.folder as string) ?? '');
        case 'create_note':
          return await this.createNote(input.path as string, input.content as string);
        case 'edit_note':
          return await this.editNote(
            input.path as string,
            input.content as string,
            (input.mode as string) ?? 'append'
          );
        default:
          return { content: `Unknown tool: ${toolName}`, isError: true };
      }
    } catch (err) {
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }

  private isProtectedPath(path: string): boolean {
    return path.startsWith('.obsidian/') || path.startsWith(this.stateFolder + '/');
  }

  private normalizePath(path: string): string {
    let p = path.trim();
    if (!p.endsWith('.md') && !p.includes('.')) p += '.md';
    return p;
  }

  private async readNote(path: string): Promise<ToolResult> {
    const normalized = this.normalizePath(path);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile)) {
      return { content: `Note not found: ${normalized}`, isError: true };
    }
    const content = await this.app.vault.cachedRead(file);
    return { content };
  }

  private async searchVault(query: string, limit: number): Promise<ToolResult> {
    const files = this.app.vault.getMarkdownFiles().filter((f) => !this.isProtectedPath(f.path));
    const queryLower = query.toLowerCase();
    const results: { path: string; excerpt: string }[] = [];

    for (const file of files) {
      if (results.length >= limit) break;

      // Check filename first
      if (file.basename.toLowerCase().includes(queryLower)) {
        const content = await this.app.vault.cachedRead(file);
        const excerpt = content.slice(0, 200);
        results.push({ path: file.path, excerpt });
        continue;
      }

      // Check content
      const content = await this.app.vault.cachedRead(file);
      const idx = content.toLowerCase().indexOf(queryLower);
      if (idx !== -1) {
        const start = Math.max(0, idx - 50);
        const end = Math.min(content.length, idx + query.length + 100);
        results.push({ path: file.path, excerpt: '...' + content.slice(start, end) + '...' });
      }
    }

    if (results.length === 0) return { content: 'No matching notes found.' };

    const formatted = results
      .map((r) => `**${r.path}**\n${r.excerpt}`)
      .join('\n\n---\n\n');
    return { content: `Found ${results.length} results:\n\n${formatted}` };
  }

  private async listFiles(folder: string): Promise<ToolResult> {
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => {
        if (this.isProtectedPath(f.path)) return false;
        if (!folder) return true;
        return f.path.startsWith(folder);
      })
      .map((f) => f.path)
      .sort();

    return { content: files.length > 0 ? files.join('\n') : 'No files found.' };
  }

  private async createNote(path: string, content: string): Promise<ToolResult> {
    const normalized = this.normalizePath(path);
    if (this.isProtectedPath(normalized)) {
      return { content: 'Cannot create notes in protected folders.', isError: true };
    }

    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing) {
      return { content: `Note already exists: ${normalized}. Use edit_note to modify it.`, isError: true };
    }

    // Ensure parent folder exists
    const parts = normalized.split('/');
    if (parts.length > 1) {
      const folderPath = parts.slice(0, -1).join('/');
      const folder = this.app.vault.getAbstractFileByPath(folderPath);
      if (!folder) {
        await this.app.vault.createFolder(folderPath);
      }
    }

    await this.app.vault.create(normalized, content);
    return { content: `Created: ${normalized}` };
  }

  private async editNote(path: string, content: string, mode: string): Promise<ToolResult> {
    const normalized = this.normalizePath(path);
    if (this.isProtectedPath(normalized)) {
      return { content: 'Cannot edit notes in protected folders.', isError: true };
    }

    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile)) {
      return { content: `Note not found: ${normalized}`, isError: true };
    }

    const existing = await this.app.vault.cachedRead(file);

    let newContent: string;
    switch (mode) {
      case 'prepend': {
        // Respect YAML frontmatter
        const fmMatch = existing.match(/^---\n[\s\S]*?\n---\n?/);
        if (fmMatch) {
          newContent = fmMatch[0] + '\n' + content + '\n' + existing.slice(fmMatch[0].length);
        } else {
          newContent = content + '\n' + existing;
        }
        break;
      }
      case 'replace':
        newContent = content;
        break;
      case 'append':
      default:
        newContent = existing + '\n' + content;
        break;
    }

    await this.app.vault.modify(file, newContent);
    return { content: `Updated: ${normalized} (${mode})` };
  }
}
