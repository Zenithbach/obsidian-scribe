import Anthropic from '@anthropic-ai/sdk';
import { VAULT_TOOLS, VaultToolExecutor } from './vault-tools';

export interface ImageAttachment {
  base64: string;
  mediaType: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  images?: ImageAttachment[];
}

export interface StreamCallbacks {
  onText: (text: string) => void;
  onThinking?: (thinking: string) => void;
  onToolUse?: (toolName: string, input: Record<string, unknown>) => void;
  onToolResult?: (toolName: string, result: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: Error) => void;
}

export class ClaudeClient {
  private client: Anthropic;
  private abortController: AbortController | null = null;

  constructor(apiKey: string) {
    this.client = new Anthropic({
      apiKey,
      // Safe in Obsidian (Electron desktop app) — the API key is never exposed
      // to a public web context. Required because the SDK detects a browser-like env.
      dangerouslyAllowBrowser: true,
    });
  }

  async streamChat(
    messages: ChatMessage[],
    noteContext: string | null,
    callbacks: StreamCallbacks,
    useThinking = false,
    toolExecutor?: VaultToolExecutor,
    maxToolCalls = 25,
    modelId = 'claude-sonnet-4-20250514',
    customSystemPrompt?: string
  ): Promise<void> {
    this.abortController = new AbortController();

    const basePrompt = customSystemPrompt
      || 'You are a helpful AI assistant integrated into Obsidian, a note-taking application. Be concise and helpful.\n\nWhen editing files, always respect YAML frontmatter blocks (--- delimited) at the top of notes.';

    const systemPrompt = noteContext
      ? `${basePrompt}\n\nThe user has the following notes in their vault that may be relevant:\n\n${noteContext}\n\nUse this context to inform your responses when relevant. When referencing information from their notes, mention which note it came from.`
      : basePrompt;

    try {
      await this.runToolLoop(messages, systemPrompt, callbacks, useThinking, toolExecutor, maxToolCalls, modelId);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') return;
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.abortController = null;
    }
  }

  private async runToolLoop(
    messages: ChatMessage[],
    systemPrompt: string,
    callbacks: StreamCallbacks,
    useThinking: boolean,
    toolExecutor?: VaultToolExecutor,
    maxLoops = 10,
    modelId = 'claude-sonnet-4-20250514'
  ): Promise<void> {
    const apiMessages: Anthropic.MessageParam[] = messages.map((m) => {
      if (m.images && m.images.length > 0) {
        const content: Anthropic.ContentBlockParam[] = m.images.map((img) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: img.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: img.base64,
          },
        }));
        content.push({ type: 'text' as const, text: m.content });
        return { role: m.role, content };
      }
      return { role: m.role, content: m.content };
    });

    let fullText = '';
    let thinkingText = '';
    let loopCount = 0;

    while (loopCount < maxLoops) {
      loopCount++;

      const params: Anthropic.MessageCreateParams = {
        model: modelId,
        max_tokens: useThinking ? 16000 : 4096,
        system: systemPrompt,
        messages: apiMessages,
      };

      if (useThinking) {
        params.thinking = { type: 'enabled', budget_tokens: 10000 };
      }

      if (toolExecutor) {
        params.tools = VAULT_TOOLS;
      }

      const stream = this.client.messages.stream(params, {
        signal: this.abortController!.signal,
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'thinking_delta') {
            thinkingText += event.delta.thinking;
            callbacks.onThinking?.(thinkingText);
          } else if (event.delta.type === 'text_delta') {
            fullText += event.delta.text;
            callbacks.onText(fullText);
          }
        }
      }

      const finalMessage = await stream.finalMessage();

      // If no tool use, we're done
      if (finalMessage.stop_reason !== 'tool_use' || !toolExecutor) {
        callbacks.onDone(fullText);
        return;
      }

      // Process tool calls
      const toolUseBlocks = finalMessage.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
      );

      if (toolUseBlocks.length === 0) {
        callbacks.onDone(fullText);
        return;
      }

      // Add assistant's full response to conversation
      apiMessages.push({ role: 'assistant', content: finalMessage.content });

      // Execute each tool and collect results
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolBlock of toolUseBlocks) {
        callbacks.onToolUse?.(toolBlock.name, toolBlock.input as Record<string, unknown>);

        const result = await toolExecutor.execute(
          toolBlock.name,
          toolBlock.input as Record<string, unknown>
        );

        callbacks.onToolResult?.(toolBlock.name, result.content);

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolBlock.id,
          content: result.content,
          is_error: result.isError,
        });
      }

      // Add tool results and continue the loop
      apiMessages.push({ role: 'user', content: toolResults });
    }

    callbacks.onDone(fullText || 'Reached maximum tool call limit.');
  }

  abort(): void {
    this.abortController?.abort();
  }
}
