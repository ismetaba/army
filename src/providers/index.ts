import 'dotenv/config';
import { createOpenAI, openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { claudeCode } from 'ai-sdk-provider-claude-code';
import type { ProviderId } from '../../shared/schemas';

function requireEnv(name: string): void {
  if (!process.env[name]) throw new Error(`${name} is not set (add it to .env)`);
}

export function getModel(provider: ProviderId, modelId: string) {
  switch (provider) {
    case 'lmstudio': {
      const lmstudio = createOpenAI({
        baseURL: process.env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234/v1',
        apiKey: 'lm-studio',
      });
      // `.chat()` = /v1/chat/completions. The default factory would be openai.responses
      // (/v1/responses), which LM Studio answers with a 500 as soon as a tool result is
      // sent back ("Invalid type for 'input'" / "Failed to parse tool call"), breaking
      // every tool-using workflow. Chat Completions round-trips tools correctly.
      return lmstudio.chat(modelId);
    }
    case 'openai': requireEnv('OPENAI_API_KEY'); return openai(modelId);
    case 'anthropic': requireEnv('ANTHROPIC_API_KEY'); return anthropic(modelId);
    case 'claude-cli': {
      // The developer's local Claude Code login (their subscription) — no API key. This plain
      // model is for tool-less calls; tool-using sessions must go through
      // `claudeCliSessionModel` (./claude-cli.ts), which bridges the toolset over MCP and
      // locks out the CLI's own built-in tools. Passing AI SDK `tools` to THIS model does
      // nothing: the provider ignores them with a warning (measured, tasks/T01.md).
      return claudeCode(modelId);
    }
  }
}
