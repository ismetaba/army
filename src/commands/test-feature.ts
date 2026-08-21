import fs from 'node:fs';
import type { Command } from 'commander';
import { runTestFeature } from '../workflows/test-feature';

/** Print to stderr and exit 1 (SPEC § exit codes). */
function fail(message: string): never {
  try {
    fs.writeSync(2, `${message}\n`);
  } catch {
    // stderr is gone; the exit code still carries the failure.
  }
  process.exit(1);
}

/** T09 — `aw test-feature`: black-box test a feature or bug report against a running app. */
export function registerTestFeature(program: Command): void {
  program
    .command('test-feature')
    .description('Black-box test a feature or bug report with the qa-tester agent')
    .argument('<desc>', 'what to verify, e.g. "the health endpoint returns 200 with build info"')
    .option('-u, --url <url>', 'target base URL (default: config app.baseUrl, else the backend port)')
    .option('--allow-destructive', 'permit POST/PUT/PATCH/DELETE against a non-local target', false)
    .option('-p, --provider <p>', 'provider id (default: config agents.qa-tester, else defaults)')
    .option('-m, --model <m>', 'model id (default: config agents.qa-tester, else defaults)')
    .option('-c, --config <path>', 'path to aw.config.json (default: ./aw.config.json)')
    .option('-w, --workspace <name>', 'workspace name; resolves the config via workspaces.json')
    .action(
      async (
        desc: string,
        opts: {
          url?: string;
          allowDestructive?: boolean;
          provider?: string;
          model?: string;
          config?: string;
          workspace?: string;
        },
      ) => {
        try {
          // Exit code stays 0 even when cases FAIL: a failing test is a finding, not a CLI
          // error (T09 Acceptance 2). Only an unrunnable session exits 1, from runTestFeature.
          await runTestFeature({ ...opts, desc });
        } catch (err) {
          // runTestFeature reports its own operational failures; anything reaching here is a
          // resolution problem (unknown provider, model missing for the chosen provider).
          fail(err instanceof Error ? err.message : String(err));
        }
      },
    );
}
