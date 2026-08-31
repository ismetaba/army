import { describe, expect, it } from 'vitest';
import {
  describeModelFailure,
  isContextOverflowError,
  isTurnLimitError,
  providerDetail,
} from './common';

/** The shape ai@7 throws for an HTTP error from an OpenAI-compatible server. */
function apiError(message: string, statusCode: number, responseBody: string): Error {
  return Object.assign(new Error(message), { statusCode, responseBody });
}

/** Verbatim from LM Studio serving a 30B model with an 8192-token context (T14). */
const LMSTUDIO_CONTEXT_400 = apiError(
  'Bad Request',
  400,
  JSON.stringify({
    error:
      'The number of tokens to keep from the initial prompt is greater than the context length. ' +
      'Try to load the model with a larger context length, or provide a shorter input',
  }),
);

describe('providerDetail', () => {
  it('unwraps the {"error": "..."} envelope a local server returns', () => {
    const detail = providerDetail(LMSTUDIO_CONTEXT_400);
    expect(detail).toContain('HTTP 400');
    expect(detail).toContain('greater than the context length');
    expect(detail).not.toContain('{"error"');
  });

  it('unwraps the nested {"error": {"message": "..."}} shape too', () => {
    const detail = providerDetail(
      apiError('Bad Request', 400, '{"error":{"message":"model not found","type":"invalid"}}'),
    );
    expect(detail).toContain('model not found');
  });

  it('quotes a non-JSON body as it came', () => {
    expect(providerDetail(apiError('Bad Request', 400, 'plain text explanation'))).toContain(
      'plain text explanation',
    );
  });

  it('does not repeat a body the SDK already put in the error message', () => {
    // The standard OpenAI envelope: ai@7 lifts `error.message` into the Error's own message, so
    // quoting it again under it just stutters. Only the status is worth adding.
    const detail = providerDetail(
      apiError('model "stub" not found. Load it first', 400, '{"error":{"message":"model \\"stub\\" not found. Load it first"}}'),
    );
    expect(detail).toBe('\n  provider said: HTTP 400');
  });

  it('adds nothing when the error carries no provider response', () => {
    expect(providerDetail(new Error('fetch failed'))).toBe('');
    expect(providerDetail('not an object')).toBe('');
    expect(providerDetail(null)).toBe('');
  });
});

describe('isContextOverflowError', () => {
  it('recognises the LM Studio context-length refusal', () => {
    expect(isContextOverflowError(LMSTUDIO_CONTEXT_400)).toBe(true);
  });

  it('recognises the OpenAI wording', () => {
    expect(
      isContextOverflowError(
        apiError(
          'Bad Request',
          400,
          '{"error":{"message":"This model\'s maximum context length is 8192 tokens"}}',
        ),
      ),
    ).toBe(true);
  });

  it('does not treat every 400 as an overflow', () => {
    expect(isContextOverflowError(apiError('Bad Request', 400, '{"error":"unknown model"}'))).toBe(
      false,
    );
  });

  it('does not treat a transport failure as an overflow', () => {
    expect(isContextOverflowError(new Error('fetch failed'))).toBe(false);
  });
});

describe('describeModelFailure', () => {
  const opts = { activity: 'the review', timeoutMs: 60_000 };

  it('appends what the provider said to an otherwise bare message', () => {
    const text = describeModelFailure(LMSTUDIO_CONTEXT_400, 'lmstudio', opts);
    expect(text).toContain('Bad Request');
    expect(text).toContain('greater than the context length');
  });

  it('still names an unreachable LM Studio first', () => {
    const text = describeModelFailure(new Error('fetch failed'), 'lmstudio', opts);
    expect(text).toContain('LM Studio is not reachable');
  });

  it('still reports a timeout as a timeout', () => {
    const text = describeModelFailure(new Error('This operation was aborted'), 'lmstudio', opts);
    expect(text).toBe('lmstudio did not finish the review within 60s.');
  });
});

describe('isTurnLimitError', () => {
  it('recognises the claude-cli spent-turn-budget rejection, in both spellings', () => {
    // Observed verbatim on the first two-repo custody design-loop (2026-08-25): the CLI bridge
    // REJECTS at maxTurns where the API providers stop gracefully via stopWhen.
    expect(isTurnLimitError(new Error('Reached maximum number of turns (60)'))).toBe(true);
    expect(isTurnLimitError(new Error('reached max number of turns'))).toBe(true);
  });

  it('does not swallow unrelated failures', () => {
    expect(isTurnLimitError(new Error('fetch failed'))).toBe(false);
    expect(isTurnLimitError(new Error('This operation was aborted'))).toBe(false);
    expect(isTurnLimitError(null)).toBe(false);
  });
});
