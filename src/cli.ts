import { Command } from 'commander';
import { registerDesignLoop } from './commands/design-loop';
import { registerPing } from './commands/ping';
import { registerReview } from './commands/review';
import { registerTestFeature } from './commands/test-feature';

const program = new Command();
program
  .name('aw')
  .description('Provider-selectable agent workflows: design-loop, test-feature, review');
registerPing(program);
registerReview(program);
registerTestFeature(program);
registerDesignLoop(program);
// remaining subcommands are registered here by later tasks (T13)

program.parse();
