import { Command } from 'commander';
import { registerPing } from './commands/ping';
import { registerReview } from './commands/review';

const program = new Command();
program
  .name('aw')
  .description('Provider-selectable agent workflows: design-loop, test-feature, review');
registerPing(program);
registerReview(program);
// remaining subcommands are registered here by later tasks (T09, T10, T13)

program.parse();
