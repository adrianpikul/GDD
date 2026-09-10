import { Ajv2020 } from 'ajv/dist/2020.js';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_CONTRACT_VERSION,
  commandFailure,
  commandSuccess,
  GddError
} from '../src/contracts.js';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const schemaDirectory = join(projectRoot, 'schemas/v1');

type JsonSchema = Record<string, unknown>;

async function schema(name: string): Promise<JsonSchema> {
  return JSON.parse(await readFile(join(schemaDirectory, name), 'utf8')) as JsonSchema;
}

describe('v1 automation contracts', () => {
  it('validates representative manifest, success, validation, and error documents', async () => {
    const ajv = new Ajv2020({ strict: true });
    const manifest = ajv.compile(await schema('manifest.schema.json'));
    const success = ajv.compile(await schema('command-success.schema.json'));
    const finding = ajv.compile(await schema('validation-finding.schema.json'));
    const failure = ajv.compile(await schema('error.schema.json'));

    expect(
      manifest({
        schemaVersion: 1,
        generatedBy: 'gdd',
        generatorVersion: '1.0.0',
        hosts: ['agents'],
        managedPaths: ['gdd/.gdd.json'],
        createdAt: '2026-09-10T12:00:00.000Z',
        updatedAt: '2026-09-10T12:00:00.000Z'
      })
    ).toBe(true);
    expect(success(commandSuccess('status', '1.0.0', { records: [] }))).toBe(true);
    expect(finding({ path: 'gdd/changes/broken/change.md', error: 'missing frontmatter' })).toBe(
      true
    );
    expect(
      failure(
        commandFailure(
          'status',
          '1.0.0',
          new GddError('Invalid status filter.', 'invalid_argument')
        )
      )
    ).toBe(true);
  });

  it('rejects unknown contract versions and unsafe manifest paths', async () => {
    const ajv = new Ajv2020({ strict: true });
    const manifest = ajv.compile(await schema('manifest.schema.json'));
    const success = ajv.compile(await schema('command-success.schema.json'));

    expect(
      success({
        contractVersion: AUTOMATION_CONTRACT_VERSION + 1,
        gddVersion: '1.0.0',
        command: 'status',
        ok: true,
        result: {}
      })
    ).toBe(false);
    expect(
      manifest({
        schemaVersion: 1,
        generatedBy: 'gdd',
        generatorVersion: '1.0.0',
        hosts: ['agents'],
        managedPaths: ['../outside'],
        createdAt: '2026-09-10T12:00:00.000Z',
        updatedAt: '2026-09-10T12:00:00.000Z'
      })
    ).toBe(false);
  });
});
