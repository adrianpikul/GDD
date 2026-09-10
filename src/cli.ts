import { checkbox, confirm } from '@inquirer/prompts';
import { Command } from 'commander';
import { createRequire } from 'node:module';
import { commandFailure, commandSuccess, type CommandName } from './contracts.js';
import { archive, init, update, status, formatActions, GddError } from './core.js';
import { gddInitIntroLines, printGftBanner } from './gft-banner.js';
import { formatStatus, shouldUseStatusColor } from './status-view.js';
import type { ChangeState, Host } from './types.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version: string };
const VERSION = packageJson.version;

type HostFlags = {
  agents?: boolean;
  github?: boolean;
  all?: boolean;
  force?: boolean;
  json?: boolean;
};

async function selectedHosts(flags: HostFlags): Promise<Host[]> {
  const fromFlags: Host[] = [
    ...(flags.agents ? ['agents' as const] : []),
    ...(flags.github ? ['github' as const] : []),
    ...(flags.all ? ['agents' as const, 'github' as const] : [])
  ];
  if (fromFlags.length) return [...new Set(fromFlags)];
  if (flags.json)
    throw new GddError(
      'Select a host with --agents, --github, or --all when using --json.',
      'invalid_argument'
    );
  if (!process.stdin.isTTY)
    throw new GddError(
      'Select a host with --agents, --github, or --all when not running interactively.',
      'invalid_argument'
    );
  await printGftBanner();
  console.log('');
  for (const line of gddInitIntroLines()) console.log(`  ${line}`);
  console.log('');
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

function showJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function assertNoRefusedActions(actions: Awaited<ReturnType<typeof init>>): void {
  const refused = actions.find((action) => action.status === 'refused');
  if (!refused) return;
  throw new GddError(
    `GDD refused to write ${refused.path}: ${refused.message ?? 'unmanaged collision'}.`,
    'unmanaged_collision',
    { path: refused.path }
  );
}

function requestedCommand(): CommandName {
  const command = process.argv.find((argument) =>
    ['archive', 'init', 'status', 'update'].includes(argument)
  );
  return (command ?? 'status') as CommandName;
}

function jsonRequested(): boolean {
  return process.argv.includes('--json');
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
  .option('--json', 'emit machine-readable JSON')
  .action(async (path = '.', flags: HostFlags) => {
    const actions = await init(path, await selectedHosts(flags), Boolean(flags.force), VERSION);
    if (flags.json) {
      assertNoRefusedActions(actions);
      showJson(commandSuccess('init', VERSION, { actions }));
      return;
    }
    showActions(actions);
  });
program
  .command('update [path]')
  .description('Refresh managed GDD templates and host assets.')
  .option('--json', 'emit machine-readable JSON')
  .action(async (path = '.', flags: { json?: boolean }) => {
    const actions = await update(path, VERSION);
    if (flags.json) {
      assertNoRefusedActions(actions);
      showJson(commandSuccess('update', VERSION, { actions }));
      return;
    }
    showActions(actions);
  });
program
  .command('status [path]')
  .description('Show GDD change records.')
  .option('--state <state>', 'filter by open or verified')
  .option('--json', 'emit machine-readable JSON')
  .action(async (path = '.', flags: { state?: ChangeState; json?: boolean }) => {
    if (flags.state && flags.state !== 'open' && flags.state !== 'verified')
      throw new GddError('--state must be open or verified', 'invalid_argument');
    const result = await status(path, flags.state);
    if (flags.json) showJson(commandSuccess('status', VERSION, result));
    else {
      const presentation = formatStatus(result, {
        color: shouldUseStatusColor(process.stdout.isTTY, process.env.NO_COLOR)
      });
      console.log(presentation.output);
      if (presentation.issues) console.error(presentation.issues);
    }
    if (result.invalid.length) process.exitCode = 1;
  });
program
  .command('archive <slug> [path]')
  .description('Archive one verified GDD change and retain aggregate completion totals.')
  .option('--yes', 'acknowledge irreversible deletion without an interactive prompt')
  .option('--json', 'emit machine-readable JSON')
  .action(async (slug: string, path = '.', flags: { yes?: boolean; json?: boolean }) => {
    if (!flags.yes) {
      if (flags.json)
        throw new GddError(
          'Archiving requires --yes when using --json.',
          'archive_confirmation_required'
        );
      if (!process.stdin.isTTY) {
        throw new GddError(
          'Archiving requires --yes when not running interactively.',
          'archive_confirmation_required'
        );
      }
      const confirmed = await confirm({
        message: `Archive verified change "${slug}"? Its GDD records will be removed.`,
        default: false
      });
      if (!confirmed) {
        console.log('Archive cancelled.');
        return;
      }
    }
    const totals = await archive(path, slug, true);
    if (flags.json) {
      showJson(commandSuccess('archive', VERSION, { slug, archive: totals }));
      return;
    }
    console.log(
      `Archived ${slug}. Totals: ${totals.changes} archived change${totals.changes === 1 ? '' : 's'} · ${totals.tasks} archived task${totals.tasks === 1 ? '' : 's'}.`
    );
  });

program.parseAsync().catch((error: unknown) => {
  if (jsonRequested()) showJson(commandFailure(requestedCommand(), VERSION, error));
  else console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
