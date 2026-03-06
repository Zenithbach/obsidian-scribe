import Anthropic from '@anthropic-ai/sdk';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamCallbacks {
  onText: (text: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: Error) => void;
}

export class ClaudeClient {
  private client: Anthropic;
  private abortController: AbortController | null = null;

  constructor(apiKey: string) {
    this.client = new Anthropic({
      apiKey,
      dangerouslyAllowBrowser: true,
    });
  }

  async streamChat(
    messages: ChatMessage[],
    noteContext: string | null,
    callbacks: StreamCallbacks
  ): Promise<void> {
    this.abortController = new AbortController();

    const systemPrompt = noteContext
      ? `You are a helpful AI assistant integrated into Obsidian, a note-taking application. The user is currently viewing the following note:\n\n---\n${noteContext}\n---\n\nUse this context to inform your responses when relevant. Be concise and helpful.`
      : 'You are a helpful AI assistant integrated into Obsidian, a note-taking application. Be concise and helpful.';

    let fullText = '';

    try {
      const stream = this.client.messages.stream(
        {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: systemPrompt,
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        },
        { signal: this.abortController.signal }
      );

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          fullText += event.delta.text;
          callbacks.onText(fullText);
        }
      }

      callbacks.onDone(fullText);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') return;
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.abortController = null;
    }
  }

  abort(): void {
    this.abortController?.abort();
  }
}
