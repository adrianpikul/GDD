import { execFile } from 'node:child_process';
import { Ajv2020 } from 'ajv/dist/2020.js';
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
const successSchemaPath = join(projectRoot, 'schemas/v1/command-success.schema.json');
const errorSchemaPath = join(projectRoot, 'schemas/v1/error.schema.json');
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

async function expectV1Schema(value: unknown, schemaPath: string): Promise<void> {
  const ajv = new Ajv2020({ strict: true });
  const validator = ajv.compile(JSON.parse(await readFile(schemaPath, 'utf8')) as object);
  expect(validator(value), JSON.stringify(validator.errors)).toBe(true);
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
    const packagedPaths = packagedEntry?.files.map((file) => file.path) ?? [];
    expect(packagedPaths).toContain(packageJson.bin.gdd);
    for (const schema of [
      'schemas/v1/manifest.schema.json',
      'schemas/v1/command-success.schema.json',
      'schemas/v1/validation-finding.schema.json',
      'schemas/v1/error.schema.json'
    ]) {
      expect(packagedPaths).toContain(schema);
    }

    const prefix = await temporaryDirectory('gdd-link-prefix-');
    await run(npmCommand, ['link'], projectRoot, { ...process.env, npm_config_prefix: prefix });
    const linkedBinary = join(prefix, 'bin', 'gdd');
    expect(await realpath(linkedBinary)).toBe(cliPath);

    const project = await temporaryDirectory('gdd-linked-consumer-');
    const initialized = await run(process.execPath, [
      linkedBinary,
      'init',
      project,
      '--agents',
      '--json'
    ]);
    const initializedResult = JSON.parse(initialized.stdout);
    await expectV1Schema(initializedResult, successSchemaPath);
    expect(initializedResult).toMatchObject({
      contractVersion: 1,
      gddVersion: packageJson.version,
      command: 'init',
      ok: true,
      result: { actions: expect.any(Array) }
    });
    await access(join(project, 'gdd/.gdd.json'));
    const updated = await run(process.execPath, [linkedBinary, 'update', project, '--json']);
    const updatedResult = JSON.parse(updated.stdout);
    await expectV1Schema(updatedResult, successSchemaPath);
    expect(updatedResult).toMatchObject({
      contractVersion: 1,
      command: 'update',
      ok: true,
      result: { actions: expect.any(Array) }
    });
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
      '--yes',
      '--json'
    ]);
    const archivedResult = JSON.parse(archived.stdout);
    await expectV1Schema(archivedResult, successSchemaPath);
    expect(archivedResult).toMatchObject({
      contractVersion: 1,
      command: 'archive',
      ok: true,
      result: { slug: 'completed-change', archive: { changes: 1, tasks: 0 } }
    });
    const status = await run(process.execPath, [linkedBinary, 'status', project, '--json']);
    const statusResult = JSON.parse(status.stdout);
    await expectV1Schema(statusResult, successSchemaPath);
    expect(statusResult).toMatchObject({
      contractVersion: 1,
      command: 'status',
      ok: true,
      result: { records: [], invalid: [], archive: { changes: 1, tasks: 0 } }
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
    const jsonResult = JSON.parse(json.stdout);
    await expectV1Schema(jsonResult, successSchemaPath);
    expect(jsonResult).toMatchObject({
      contractVersion: 1,
      command: 'status',
      ok: true,
      result: {
        records: [{ id: 'valid-change' }],
        invalid: [{ path: 'gdd/changes/broken-change/change.md' }]
      }
    });

    const invalidArgument = await run(
      process.execPath,
      [cliPath, 'status', project, '--state', 'in-progress', '--json'],
      projectRoot,
      process.env,
      true
    );
    expect(invalidArgument.exitCode).toBe(1);
    expect(invalidArgument.stderr).toBe('');
    const invalidArgumentResult = JSON.parse(invalidArgument.stdout);
    await expectV1Schema(invalidArgumentResult, errorSchemaPath);
    expect(invalidArgumentResult).toMatchObject({
      contractVersion: 1,
      command: 'status',
      ok: false,
      error: { code: 'invalid_argument' }
    });
  });

  it('emits structured JSON failures without presentation output', async () => {
    const project = await temporaryDirectory('gdd-json-errors-');
    const notInitialized = await run(
      process.execPath,
      [cliPath, 'update', project, '--json'],
      projectRoot,
      process.env,
      true
    );
    expect(notInitialized.exitCode).toBe(1);
    expect(notInitialized.stderr).toBe('');
    const notInitializedResult = JSON.parse(notInitialized.stdout);
    await expectV1Schema(notInitializedResult, errorSchemaPath);
    expect(notInitializedResult).toMatchObject({
      command: 'update',
      ok: false,
      error: { code: 'not_initialized' }
    });

    const missingHost = await run(
      process.execPath,
      [cliPath, 'init', project, '--json'],
      projectRoot,
      process.env,
      true
    );
    expect(missingHost.exitCode).toBe(1);
    expect(missingHost.stderr).toBe('');
    const missingHostResult = JSON.parse(missingHost.stdout);
    await expectV1Schema(missingHostResult, errorSchemaPath);
    expect(missingHostResult).toMatchObject({
      command: 'init',
      ok: false,
      error: { code: 'invalid_argument' }
    });

    await run(process.execPath, [cliPath, 'init', project, '--agents']);
    const confirmation = await run(
      process.execPath,
      [cliPath, 'archive', 'missing-change', project, '--json'],
      projectRoot,
      process.env,
      true
    );
    expect(confirmation.exitCode).toBe(1);
    expect(confirmation.stderr).toBe('');
    const confirmationResult = JSON.parse(confirmation.stdout);
    await expectV1Schema(confirmationResult, errorSchemaPath);
    expect(confirmationResult).toMatchObject({
      command: 'archive',
      ok: false,
      error: { code: 'archive_confirmation_required' }
    });
  });
});
