import 'dotenv/config';
import { createOpenAI, openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import type { ProviderId } from '../../shared/schemas';
import { CLAUDE_CLI_REFUSAL } from '../workflows/common';

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
      // Import lazily; check the package README/types for the exact factory export
      // (expected: `claudeCode`). No API key needed — uses the local Claude Code login.
      // One wording, shared with the three workflows (src/workflows/common.ts): the refusal is a
      // user-facing contract and a second sentence for the same condition is exactly the drift
      // that constant exists to prevent.
      throw new Error(`${CLAUDE_CLI_REFUSAL}\n  (ping may still implement it: see T04)`);
    }
  }
}
