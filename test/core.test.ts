import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GddError, init, isInside, readManifest, status, update } from '../src/core.js';

const roots: string[] = [];
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gdd-test-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('GDD generation', () => {
  it('initializes both host integrations and persists a manifest', async () => {
    const root = await project();
    const actions = await init(root, ['agents', 'github'], false, '1.2.3');
    expect(actions.filter((action) => action.status === 'created')).toHaveLength(11);
    expect(await readManifest(root)).toMatchObject({
      generatorVersion: '1.2.3',
      hosts: ['agents', 'github']
    });
    expect(await readFile(join(root, '.github/prompts/gdd-work.prompt.md'), 'utf8')).toContain(
      'gdd: true'
    );
    expect(await readFile(join(root, '.agents/skills/gdd-check/SKILL.md'), 'utf8')).toContain(
      '# Check'
    );
    expect(await readFile(join(root, 'gdd/templates/task.template.md'), 'utf8')).toContain(
      'dependsOn: []'
    );
    expect(await readFile(join(root, '.github/prompts/gdd-shape.prompt.md'), 'utf8')).toContain(
      'tasks/<stable-id>-<slug>.md'
    );
    expect(
      (await init(root, ['agents', 'github'], false, '1.2.3')).every(
        (action) => action.status === 'unchanged'
      )
    ).toBe(true);
  });

  it('refuses unmanaged collisions even with force', async () => {
    const root = await project();
    await mkdir(join(root, '.github/prompts'), { recursive: true });
    await writeFile(join(root, '.github/prompts/gdd-work.prompt.md'), 'user content');
    const actions = await init(root, ['github'], true, '1.0.0');
    expect(actions.find((action) => action.path.endsWith('gdd-work.prompt.md'))).toMatchObject({
      status: 'refused'
    });
    expect(await readFile(join(root, '.github/prompts/gdd-work.prompt.md'), 'utf8')).toBe(
      'user content'
    );
  });

  it('refreshes differing owned content only with force', async () => {
    const root = await project();
    await init(root, ['agents'], false, '1.0.0');
    const path = join(root, '.agents/skills/gdd-work/SKILL.md');
    await writeFile(path, '---\ngdd: true\n---\nold');
    expect(
      (await init(root, ['agents'], false, '1.0.0')).find((action) =>
        action.path.endsWith('gdd-work/SKILL.md')
      )
    ).toMatchObject({ status: 'unchanged' });
    expect(
      (await init(root, ['agents'], true, '1.0.0')).find((action) =>
        action.path.endsWith('gdd-work/SKILL.md')
      )
    ).toMatchObject({ status: 'updated' });
  });

  it('preserves previously selected hosts on later initialization', async () => {
    const root = await project();
    await init(root, ['agents', 'github'], false, '1.0.0');
    await init(root, ['agents'], false, '1.0.0');
    expect((await readManifest(root))?.hosts).toEqual(['agents', 'github']);
  });

  it('does not follow a symbolic link in a managed path', async () => {
    const root = await project();
    const outside = await project();
    await mkdir(join(root, '.agents'), { recursive: true });
    await symlink(outside, join(root, '.agents/skills'));
    await expect(init(root, ['agents'], false, '1.0.0')).rejects.toBeInstanceOf(GddError);
  });
});

describe('status', () => {
  it('reads valid records, filters state, and reports malformed files', async () => {
    const root = await project();
    await init(root, ['agents'], false, '1.0.0');
    await mkdir(join(root, 'gdd/add-login'), { recursive: true });
    await writeFile(
      join(root, 'gdd/add-login/change.md'),
      '---\nid: add-login\ntitle: Add login\nstate: open\nupdated: 2026-09-09T00:00:00Z\n---\n\n# Intent\n\n## Next\n\nImplement login\n'
    );
    await mkdir(join(root, 'gdd/bad'), { recursive: true });
    await writeFile(join(root, 'gdd/bad/change.md'), 'bad');
    const result = await status(root, 'open');
    expect(result.records).toMatchObject([{ id: 'add-login', next: 'Implement login' }]);
    expect(result.invalid).toHaveLength(1);
  });

  it('updates only paths recorded in the manifest', async () => {
    const root = await project();
    await init(root, ['agents'], false, '1.0.0');
    const actions = await update(root, '2.0.0');
    expect(actions.some((action) => action.path.startsWith('.github'))).toBe(false);
    expect((await readManifest(root))?.generatorVersion).toBe('2.0.0');
  });

  it('aggregates nested task records and leaves an active parent open', async () => {
    const root = await project();
    await init(root, ['agents'], false, '1.0.0');
    await writeChange(root, 'add-login', 'open', 'T001 T002');
    await writeTask(
      root,
      'add-login',
      'nested/T001-schema',
      'T001',
      'verified',
      [],
      'schema test passed'
    );
    await writeTask(
      root,
      'add-login',
      'T002-route',
      'T002',
      'open',
      ['T001'],
      '<await implementation>'
    );
    const result = await status(root, 'open');
    expect(result.records).toMatchObject([
      { id: 'add-login', tasks: { total: 2, verified: 1, open: 1, invalid: 0 } }
    ]);
    expect(result.invalid).toEqual([]);
  });

  it('accepts a verified parent only when tasks and parent evidence are complete', async () => {
    const root = await project();
    await init(root, ['agents'], false, '1.0.0');
    await writeChange(root, 'verified-change', 'verified', 'T001', 'integration test passed');
    await writeTask(
      root,
      'verified-change',
      'T001-core',
      'T001',
      'verified',
      [],
      'unit test passed'
    );
    const result = await status(root, 'verified');
    expect(result.records).toHaveLength(1);
    expect(result.invalid).toEqual([]);
  });

  it('reports malformed, unevidenced, and inconsistent task evidence', async () => {
    const root = await project();
    await init(root, ['agents'], false, '1.0.0');
    await writeChange(root, 'inconsistent', 'verified', 'T001 T002', 'integration test passed');
    await writeTask(root, 'inconsistent', 'T001-open', 'T001', 'open', [], 'waiting');
    await writeTask(
      root,
      'inconsistent',
      'T002-no-evidence',
      'T002',
      'verified',
      [],
      '<actual evidence>'
    );
    const result = await status(root);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.tasks).toMatchObject({ total: 2, open: 1, invalid: 1 });
    const errors = result.invalid.map((issue) => issue.error).join(' ');
    expect(errors).toContain('verified change has incomplete or invalid tasks');
    expect(errors).toContain('verified task requires substantive ## Evidence');
  });

  it('does not rewrite existing change history during update', async () => {
    const root = await project();
    await init(root, ['agents'], false, '1.0.0');
    await writeChange(root, 'preserved', 'open', '');
    const path = join(root, 'gdd/preserved/change.md');
    const before = await readFile(path, 'utf8');
    await update(root, '2.0.0');
    expect(await readFile(path, 'utf8')).toBe(before);
  });
});

it('checks paths are root-contained', () => {
  expect(isInside('/project', '/project/gdd/x')).toBe(true);
  expect(isInside('/project', '/outside')).toBe(false);
});

async function writeChange(
  root: string,
  slug: string,
  state: 'open' | 'verified',
  work: string,
  evidence = 'Not yet required'
): Promise<void> {
  const directory = join(root, 'gdd', slug);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'change.md'),
    `---\nid: ${slug}\ntitle: ${slug}\nstate: ${state}\nupdated: 2026-09-09T00:00:00Z\n---\n\n# Intent\n\n## Work\n\n${work}\n\n## Evidence\n\n${evidence}\n\n## Next\n\nContinue\n`
  );
}

async function writeTask(
  root: string,
  change: string,
  file: string,
  id: string,
  state: 'open' | 'verified',
  dependsOn: string[],
  evidence: string
): Promise<void> {
  const path = join(root, 'gdd', change, 'tasks', `${file}.md`);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(
    path,
    `---\nid: ${id}\ntitle: ${id}\nstate: ${state}\nupdated: 2026-09-09T00:00:00Z\ndependsOn: ${JSON.stringify(dependsOn)}\n---\n\n# Outcome\n\nDeliver ${id}\n\n## Acceptance and check\n\nRun ${id} test\n\n## Evidence\n\n${evidence}\n\n## Next\n\nContinue\n`
  );
}
