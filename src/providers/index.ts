import 'dotenv/config';
import { createOpenAI, openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
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
      return lmstudio(modelId);
    }
    case 'openai': requireEnv('OPENAI_API_KEY'); return openai(modelId);
    case 'anthropic': requireEnv('ANTHROPIC_API_KEY'); return anthropic(modelId);
    case 'claude-cli': {
      // Import lazily; check the package README/types for the exact factory export
      // (expected: `claudeCode`). No API key needed — uses the local Claude Code login.
      throw new Error('claude-cli supports no AI SDK tool execution — use provider "anthropic" for CLI workflows, or the .claude/ native path. (ping may still implement it: see T04)');
    }
  }
}
