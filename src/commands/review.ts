import fs from 'node:fs';
import type { Command } from 'commander';
import { hasBlocker, runReview } from '../workflows/review';

/** Print to stderr and exit 1 (SPEC § exit codes). */
function fail(message: string): never {
  try {
    fs.writeSync(2, `${message}\n`);
  } catch {
    // stderr is gone; the exit code still carries the failure.
  }
  process.exit(1);
}

/** T08 — `aw review`: review `<base>...HEAD` of the configured repo. */
export function registerReview(program: Command): void {
  program
    .command('review')
    .description('Review the diff between a base ref and HEAD with the code-reviewer agent')
    .option('-b, --base <ref>', 'base ref to diff against', 'main')
    .option('-p, --provider <p>', 'provider id (default: config agents.code-reviewer, else defaults)')
    .option('-m, --model <m>', 'model id (default: config agents.code-reviewer, else defaults)')
    .option('-c, --config <path>', 'path to aw.config.json (default: ./aw.config.json)')
    .option('-w, --workspace <name>', 'workspace name; resolves the config via workspaces.json')
    .action(
      async (opts: {
        base: string;
        provider?: string;
        model?: string;
        config?: string;
        workspace?: string;
      }) => {
        try {
          const { verdict, findings } = await runReview(opts);
          // Exit 2 = "a BLOCKER was reported"; the review itself succeeded, so nothing is printed.
          // An explicit APPROVE suppresses it: a model that quotes a `[BLOCKER] …` example line
          // (SPEC.md contains one) must not fail a CI gate on an approved branch. The
          // contradiction is reported as a `warning:` on stderr either way.
          if (verdict !== 'APPROVE' && hasBlocker(findings)) process.exitCode = 2;
        } catch (err) {
          // runReview reports its own operational failures; anything reaching here is a
          // resolution problem (unknown provider, model missing for the chosen provider).
          fail(err instanceof Error ? err.message : String(err));
        }
      },
    );
}
