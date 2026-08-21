import { Command } from 'commander';

const program = new Command();
program
  .name('aw')
  .description('Provider-selectable agent workflows: design-loop, test-feature, review');
// subcommands are registered here by later tasks (T04, T08, T09, T10, T13)

program.parse();
