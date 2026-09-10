import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
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
  env: NodeJS.ProcessEnv = process.env
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, env }, (error, stdout, stderr) => {
      if (error) {
        error.message += `\n${stderr}`;
        reject(error);
        return;
      }
      resolve({ stdout });
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
    const status = await run(process.execPath, [linkedBinary, 'status', project, '--json']);
    expect(JSON.parse(status.stdout)).toMatchObject({ records: [], invalid: [] });
  });
});
