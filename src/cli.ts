import { checkbox } from '@inquirer/prompts';
import { Command } from 'commander';
import { createRequire } from 'node:module';
import { init, update, status, formatActions, GddError } from './core.js';
import { formatStatus, shouldUseStatusColor } from './status-view.js';
import type { ChangeState, Host } from './types.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version: string };
const VERSION = packageJson.version;

type HostFlags = { agents?: boolean; github?: boolean; all?: boolean; force?: boolean };

async function selectedHosts(flags: HostFlags): Promise<Host[]> {
  const fromFlags: Host[] = [
    ...(flags.agents ? ['agents' as const] : []),
    ...(flags.github ? ['github' as const] : []),
    ...(flags.all ? ['agents' as const, 'github' as const] : [])
  ];
  if (fromFlags.length) return [...new Set(fromFlags)];
  if (!process.stdin.isTTY)
    throw new GddError(
      'Select a host with --agents, --github, or --all when not running interactively.'
    );
  const selected = await checkbox<Host>({
    message: 'Select agent integrations',
    choices: [
      { name: 'Codex skills (.agents)', value: 'agents' },
      { name: 'GitHub Copilot prompts (.github)', value: 'github' }
    ],
    required: true
  });
  return selected;
}

function showActions(actions: Awaited<ReturnType<typeof init>>): void {
  if (actions.length) console.log(formatActions(actions));
  const refused = actions.some((action) => action.status === 'refused');
  if (refused) process.exitCode = 1;
}

const program = new Command();
program
  .name('gdd')
  .description('Generate and maintain evidence-driven GDD prompts and skills.')
  .version(VERSION);
program
  .command('init [path]')
  .description('Initialize GDD assets in a project.')
  .option('--agents', 'generate Codex skills under .agents')
  .option('--github', 'generate GitHub Copilot prompts under .github')
  .option('--all', 'generate both hosts')
  .option('--force', 'refresh differing GDD-managed files and repair incomplete installs')
  .action(async (path = '.', flags: HostFlags) => {
    showActions(await init(path, await selectedHosts(flags), Boolean(flags.force), VERSION));
  });
program
  .command('update [path]')
  .description('Refresh managed GDD templates and host assets.')
  .action(async (path = '.') => {
    showActions(await update(path, VERSION));
  });
program
  .command('status [path]')
  .description('Show GDD change records.')
  .option('--state <state>', 'filter by open or verified')
  .option('--json', 'emit machine-readable JSON')
  .action(async (path = '.', flags: { state?: ChangeState; json?: boolean }) => {
    if (flags.state && flags.state !== 'open' && flags.state !== 'verified')
      throw new GddError('--state must be open or verified');
    const result = await status(path, flags.state);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else {
      const presentation = formatStatus(result, {
        color: shouldUseStatusColor(process.stdout.isTTY, process.env.NO_COLOR)
      });
      console.log(presentation.output);
      if (presentation.issues) console.error(presentation.issues);
    }
    if (result.invalid.length) process.exitCode = 1;
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
