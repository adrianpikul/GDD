import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as {
  bin: { gdd: string };
  version: string;
};
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(projectRoot, packageJson.bin.gdd);
const temporaryPaths: string[] = [];
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

function run(
  command: string,
  args: string[],
  cwd = projectRoot,
  env: NodeJS.ProcessEnv = process.env,
  allowFailure = false
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, env }, (error, stdout, stderr) => {
      if (error && !allowFailure) {
        error.message += `\n${stderr}`;
        reject(error);
        return;
      }
      resolve({ stdout, stderr, exitCode: typeof error?.code === 'number' ? error.code : 0 });
    });
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe.sequential('built CLI distribution', () => {
  beforeAll(async () => {
    await run(npmCommand, ['run', 'build']);
  });

  it('emits the documented ESM CLI artifact and command interface', async () => {
    await access(cliPath);
    await access(`${cliPath}.map`);
    expect((await readFile(cliPath, 'utf8')).startsWith('#!/usr/bin/env node\n')).toBe(true);

    const version = await run(process.execPath, [cliPath, '--version']);
    expect(version.stdout.trim()).toBe(packageJson.version);

    const help = await run(process.execPath, [cliPath, '--help']);
    expect(help.stdout).toMatch(/\binit\b/);
    expect(help.stdout).toMatch(/\bupdate\b/);
    expect(help.stdout).toMatch(/\bstatus\b/);
    expect(help.stdout).toMatch(/\barchive\b/);
  });

  it('packages and links the binary while retaining command workflows', async () => {
    const pack = await run(npmCommand, ['pack', '--dry-run', '--json']);
    const packageContents = JSON.parse(pack.stdout) as
      | Array<{ files: Array<{ path: string }> }>
      | Record<string, { files: Array<{ path: string }> }>;
    const packagedEntry = Array.isArray(packageContents)
      ? packageContents[0]
      : Object.values(packageContents)[0];
    expect(packagedEntry?.files.map((file) => file.path)).toContain(packageJson.bin.gdd);

    const prefix = await temporaryDirectory('gdd-link-prefix-');
    await run(npmCommand, ['link'], projectRoot, { ...process.env, npm_config_prefix: prefix });
    const linkedBinary = join(prefix, 'bin', 'gdd');
    expect(await realpath(linkedBinary)).toBe(cliPath);

    const project = await temporaryDirectory('gdd-linked-consumer-');
    await run(process.execPath, [linkedBinary, 'init', project, '--agents']);
    await access(join(project, 'gdd/.gdd.json'));
    await run(process.execPath, [linkedBinary, 'update', project]);
    const changeDirectory = join(project, 'gdd/changes/completed-change');
    await mkdir(changeDirectory, { recursive: true });
    await writeFile(
      join(changeDirectory, 'change.md'),
      '---\nid: completed-change\ntitle: Completed change\nstate: verified\nupdated: 2026-09-10T12:00:00Z\ntaskMode: direct\n---\n\n# Intent\n\n## Evidence\n\nIntegration check passed.\n\n## Next\n\nChange verified.\n'
    );
    const missingAcknowledgement = await run(
      process.execPath,
      [linkedBinary, 'archive', 'completed-change', project],
      projectRoot,
      process.env,
      true
    );
    expect(missingAcknowledgement.exitCode).toBe(1);
    expect(missingAcknowledgement.stderr).toContain('requires --yes');
    const archived = await run(process.execPath, [
      linkedBinary,
      'archive',
      'completed-change',
      project,
      '--yes'
    ]);
    expect(archived.stdout).toContain('Archived completed-change.');
    const forcedChangeDirectory = join(project, 'gdd/changes/open-change');
    await mkdir(forcedChangeDirectory, { recursive: true });
    await writeFile(
      join(forcedChangeDirectory, 'change.md'),
      '---\nid: open-change\ntitle: Open change\nstate: open\nupdated: 2026-09-10T12:00:00Z\ntaskMode: direct\n---\n\n# Intent\n\n## Next\n\nDo not archive without force.\n'
    );
    const forced = await run(process.execPath, [
      linkedBinary,
      'archive',
      'open-change',
      project,
      '--force',
      '--yes'
    ]);
    expect(forced.stdout).toContain('Archived open-change.');
    const status = await run(process.execPath, [linkedBinary, 'status', project, '--json']);
    expect(JSON.parse(status.stdout)).toMatchObject({
      records: [],
      invalid: [],
      archive: { changes: 2, tasks: 0 }
    });
  });

  it('keeps human status streams readable and JSON isolated when records are invalid', async () => {
    const project = await temporaryDirectory('gdd-status-consumer-');
    await run(process.execPath, [cliPath, 'init', project, '--agents']);
    const changeDirectory = join(project, 'gdd/changes/valid-change');
    await mkdir(changeDirectory, { recursive: true });
    await writeFile(
      join(changeDirectory, 'change.md'),
      '---\nid: valid-change\ntitle: Valid change\nstate: open\nupdated: 2026-09-10T11:28:50Z\n---\n\n# Intent\n\n## Next\n\nBuild the change.\n'
    );
    const invalidDirectory = join(project, 'gdd/changes/broken-change');
    await mkdir(invalidDirectory, { recursive: true });
    await writeFile(join(invalidDirectory, 'change.md'), 'not a GDD record\n');

    const human = await run(
      process.execPath,
      [cliPath, 'status', project],
      projectRoot,
      process.env,
      true
    );
    expect(human.exitCode).toBe(1);
    expect(human.stdout).toContain('GDD status');
    expect(human.stdout).toContain('OPEN  Valid change');
    expect(human.stdout).not.toContain('\u001B[');
    expect(human.stderr).toContain('GDD issues');
    expect(human.stderr).toContain('gdd/changes/broken-change/change.md');

    const json = await run(
      process.execPath,
      [cliPath, 'status', project, '--json'],
      projectRoot,
      { ...process.env, NO_COLOR: '' },
      true
    );
    expect(json.exitCode).toBe(1);
    expect(json.stderr).toBe('');
    expect(json.stdout).not.toContain('\u001B[');
    expect(JSON.parse(json.stdout)).toMatchObject({
      records: [{ id: 'valid-change' }],
      invalid: [{ path: 'gdd/changes/broken-change/change.md' }]
    });
  });
});
