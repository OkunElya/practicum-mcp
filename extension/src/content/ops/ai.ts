/**
 * The platform's AI chat ("Практикум ИИ"), driven like a user: open the panel,
 * type, send. State lives in `chatYaGPT.aiChatReducer` (docs/platform-findings.md §5c).
 */
import { ToolError } from '../../shared/protocol';
import { press, setText } from '../input';
import { isVisible, state } from '../page';

export interface AiState {
  available: boolean;
  open: boolean;
  loading: boolean;
  chatId: string | null;
  count: number;
  last: { type: string; streaming: boolean; text: string } | null;
  suggestions: string[];
}

export function aiState(): AiState {
  const c = state()?.chatYaGPT?.aiChatReducer;
  const button = document.querySelector('[data-test-id="sidebar-gpt-button"]');
  const messages: any[] = c?.messages ? Array.from(c.messages) : [];
  const last = messages[messages.length - 1];
  return {
    available: !!c && isVisible(button),
    open: !!c?.isChatOpened,
    loading: !!c?.isLoading,
    chatId: c?.chatId != null ? String(c.chatId) : null,
    count: messages.length,
    last: last ? { type: String(last.type), streaming: !!last.isStreaming, text: String(last.text ?? '') } : null,
    suggestions: c?.suggestions ? Array.from(c.suggestions as any[], (s) => String(s.text ?? '')) : [],
  };
}

export async function aiOpen(): Promise<true> {
  const button = document.querySelector<HTMLElement>('[data-test-id="sidebar-gpt-button"]');
  if (!button || !isVisible(button)) throw new ToolError('the AI chat button is not on this page (open a lesson or task)');
  await press(button, 'open Практикум ИИ');
  return true;
}

export async function aiSend({ question }: { question: string }): Promise<true> {
  const input = document.querySelector<HTMLTextAreaElement>('textarea.ai-chat__input');
  if (!input || !isVisible(input)) throw new ToolError('the chat input is not visible');
  await setText(input, question, 'question');
  const submit = document.querySelector<HTMLButtonElement>('[data-test-id="ai-chat-submit"]');
  if (!submit || !isVisible(submit)) throw new ToolError('the send button is not visible');
  for (let i = 0; i < 20 && submit.disabled; i++) await new Promise((r) => setTimeout(r, 100));
  if (submit.disabled) throw new ToolError('the send button stays disabled');
  await press(submit, 'send');
  return true;
}
