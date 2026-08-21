import fs from 'node:fs';
import type { Command } from 'commander';
import { runDesignLoop } from '../workflows/design-loop';

/** Print to stderr and exit 1 (SPEC § exit codes). */
function fail(message: string): never {
  try {
    fs.writeSync(2, `${message}\n`);
  } catch {
    // stderr is gone; the exit code still carries the failure.
  }
  process.exit(1);
}

/** T10 — `aw design-loop`: implement UI, verify it in a browser, checkpoint, stop for feedback. */
export function registerDesignLoop(program: Command): void {
  program
    .command('design-loop')
    .description('Implement and visually verify UI with the ui-designer agent, then stop for feedback')
    .argument('<feature>', 'feature description, or a path to a spec file')
    .option('-i, --iterate <feedback>', 'feedback to apply to the existing implementation')
    .option('-p, --provider <p>', 'provider id (default: config agents.ui-designer, else defaults)')
    .option('-m, --model <m>', 'model id (default: config agents.ui-designer, else defaults)')
    .option('-c, --config <path>', 'path to aw.config.json (default: ./aw.config.json)')
    .option('-w, --workspace <name>', 'workspace name; resolves the config via workspaces.json')
    .action(
      async (
        feature: string,
        opts: {
          iterate?: string;
          provider?: string;
          model?: string;
          config?: string;
          workspace?: string;
        },
      ) => {
        try {
          // A finished loop always exits 0: it stops for feedback, which is a success, not an
          // error. runDesignLoop exits 1 itself for the cases where the run was impossible.
          await runDesignLoop({ ...opts, feature });
        } catch (err) {
          // runDesignLoop reports its own operational failures; anything reaching here is a
          // resolution problem (unknown provider, model missing for the chosen provider).
          fail(err instanceof Error ? err.message : String(err));
        }
      },
    );
}
