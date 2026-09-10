import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatStatus,
  GddError,
  init,
  isInside,
  readManifest,
  status,
  update
} from '../src/core.js';

const roots: string[] = [];
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
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
    expect(actions.filter((action) => action.status === 'created')).toHaveLength(12);
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
    expect(await readFile(join(root, 'gdd/templates/tasks.template.md'), 'utf8')).toContain(
      'Checkbox state is authoritative'
    );
    expect(await readFile(join(root, '.github/prompts/gdd-shape.prompt.md'), 'utf8')).toContain(
      'tasks/<stable-id>-<slug>.md'
    );
    expect(await readFile(join(root, '.github/prompts/gdd-shape.prompt.md'), 'utf8')).toContain(
      'Use this exact canonical wire format'
    );
    expect(await readFile(join(root, '.agents/skills/gdd-shape/SKILL.md'), 'utf8')).toContain(
      'id: T001'
    );
    expect(await readFile(join(root, '.agents/skills/gdd-shape/SKILL.md'), 'utf8')).toContain(
      'choose and write its `taskMode`'
    );
    expect(await readFile(join(root, 'gdd/templates/change.template.md'), 'utf8')).toContain(
      'taskMode: decomposed'
    );
    expect(await readFile(join(root, 'gdd/templates/plan.template.md'), 'utf8')).toContain(
      '1. T001'
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

  it('adds newly introduced canonical assets during update', async () => {
    const root = await project();
    await init(root, ['agents'], false, '1.0.0');
    const templatePath = join(root, 'gdd/templates/tasks.template.md');
    await rm(templatePath);
    await update(root, '2.0.0');
    expect(await readFile(templatePath, 'utf8')).toContain('Checkbox state is authoritative');
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
      { id: 'add-login', tasks: { total: 2, completed: 1, open: 1, invalid: 0 } }
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

  it('uses a checkbox index as the authoritative state for new change paths', async () => {
    const root = await project();
    await init(root, ['agents'], false, '1.0.0');
    await writeIndexedChange(root, 'checkout', 'open');
    await writeIndexedTask(root, 'checkout', 'T001-payment.md', 'T001', [], 'payment test passed');
    await writeIndexedTask(
      root,
      'checkout',
      'T002-email.md',
      'T002',
      ['T001'],
      '<await implementation>'
    );
    await writeTaskIndex(root, 'checkout', [
      { id: 'T001', completed: true, file: 'T001-payment.md' },
      { id: 'T002', completed: false, file: 'T002-email.md' }
    ]);
    const result = await status(root, 'open');
    expect(result.records).toMatchObject([
      {
        path: 'gdd/changes/checkout/change.md',
        tasks: { total: 2, completed: 1, open: 1, invalid: 0 }
      }
    ]);
    expect(result.invalid).toEqual([]);
  });

  it('rejects checked tasks without evidence and unindexed task files', async () => {
    const root = await project();
    await init(root, ['agents'], false, '1.0.0');
    await writeIndexedChange(root, 'broken-index', 'verified', 'parent integration passed');
    await writeIndexedTask(
      root,
      'broken-index',
      'T001-evidence.md',
      'T001',
      [],
      '<actual evidence>'
    );
    await writeIndexedTask(root, 'broken-index', 'T002-unindexed.md', 'T002', [], 'test passed');
    await writeTaskIndex(root, 'broken-index', [
      { id: 'T001', completed: true, file: 'T001-evidence.md' }
    ]);
    const result = await status(root);
    const errors = result.invalid.map((issue) => issue.error).join(' ');
    expect(errors).toContain('checked task requires substantive ## Evidence');
    expect(errors).toContain('task is not indexed in tasks.md: T002');
    expect(errors).toContain('verified change has incomplete or invalid tasks');
  });

  it('rejects malformed and escaping checklist links', async () => {
    const root = await project();
    await init(root, ['agents'], false, '1.0.0');
    await writeIndexedChange(root, 'unsafe-index', 'open');
    const directory = join(root, 'gdd/changes/unsafe-index');
    await writeFile(join(directory, 'tasks.md'), '- [ ] T001 Unsafe — [details](../change.md)\n');
    const result = await status(root);
    expect(result.invalid.map((issue) => issue.error).join(' ')).toContain(
      'task link escapes tasks directory'
    );
  });

  it('reports missing linked files and duplicate checklist IDs', async () => {
    const root = await project();
    await init(root, ['agents'], false, '1.0.0');
    await writeIndexedChange(root, 'duplicate-index', 'open');
    const directory = join(root, 'gdd/changes/duplicate-index');
    await writeFile(
      join(directory, 'tasks.md'),
      '- [ ] T001 First — [details](tasks/missing.md)\n- [ ] T001 Duplicate — [details](tasks/other.md)\n'
    );
    const result = await status(root);
    expect(result.invalid.map((issue) => issue.error).join(' ')).toContain(
      'duplicate task ID in tasks.md: T001'
    );
  });

  it('reports a checkbox link whose task file is missing', async () => {
    const root = await project();
    await init(root, ['agents'], false, '1.0.0');
    await writeIndexedChange(root, 'missing-link', 'open');
    await writeTaskIndex(root, 'missing-link', [
      { id: 'T001', completed: false, file: 'missing.md' }
    ]);
    const result = await status(root);
    expect(result.invalid.map((issue) => issue.error).join(' ')).toContain(
      'linked task file is missing or invalid'
    );
  });

  it('preserves a generated change index during update', async () => {
    const root = await project();
    await init(root, ['agents'], false, '1.0.0');
    await writeIndexedChange(root, 'preserved-index', 'open');
    await writeTaskIndex(root, 'preserved-index', [
      { id: 'T001', completed: false, file: 'T001-work.md' }
    ]);
    const path = join(root, 'gdd/changes/preserved-index/tasks.md');
    const before = await readFile(path, 'utf8');
    await update(root, '2.0.0');
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('accepts the five-task Shape artifact fixture as an open plan', async () => {
    const root = await project();
    await init(root, ['agents'], false, '1.0.0');
    await copyFixture(root, 'shape-task-plan', 'event-blue-red-themes');

    const result = await status(root, 'open');

    expect(result.records).toMatchObject([
      {
        id: 'event-blue-red-themes',
        tasks: { total: 5, open: 5, completed: 0, invalid: 0 }
      }
    ]);
    expect(result.invalid).toEqual([]);
    expect(formatStatus(result.records)).toContain('tasks: 0/5 complete');
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({
      records: [{ id: 'event-blue-red-themes', tasks: { total: 5, open: 5, completed: 0 } }],
      invalid: []
    });
  });

  it('rejects checked Shape tasks that only report untested or blocked evidence', async () => {
    const root = await project();
    await init(root, ['agents'], false, '1.0.0');
    await writeIndexedChange(root, 'shape-evidence', 'open');
    await writeShapeTask(
      root,
      'shape-evidence',
      'untested.md',
      'Wait for decision',
      'Untested — pending decision.'
    );
    await writeShapeTask(
      root,
      'shape-evidence',
      'blocked.md',
      'Wait for implementation',
      'Blocked — pending implementation.'
    );
    await writeShapeTaskIndex(root, 'shape-evidence', [
      { completed: true, file: 'untested.md', title: 'Wait for decision' },
      { completed: true, file: 'blocked.md', title: 'Wait for implementation' }
    ]);

    const result = await status(root);

    expect(result.records[0]?.tasks).toMatchObject({ total: 2, open: 0, completed: 2, invalid: 2 });
    expect(
      result.invalid.filter((issue) => issue.error.includes('substantive ## Evidence'))
    ).toHaveLength(2);
  });

  it('reports malformed, unsafe, missing, duplicate, and unindexed Shape task artifacts', async () => {
    const root = await project();
    await init(root, ['agents'], false, '1.0.0');

    await writeIndexedChange(root, 'shape-malformed', 'open');
    const malformedDirectory = join(root, 'gdd/changes/shape-malformed');
    await mkdir(join(malformedDirectory, 'tasks'), { recursive: true });
    await writeFile(
      join(malformedDirectory, 'tasks/broken.md'),
      '<!-- gdd: true -->\n# Task: Broken task\n\n## Outcome\n\nMissing check section.\n\n## Dependencies\n\nNone.\n\n## Evidence\n\nUntested.\n\n## Next\n\nAdd the check.\n'
    );
    await writeFile(
      join(malformedDirectory, 'tasks.md'),
      '- [ ] [Broken task](tasks/broken.md)\n- [ ] [Outside](../change.md)\n'
    );

    await writeIndexedChange(root, 'shape-missing', 'open');
    await writeShapeTaskIndex(root, 'shape-missing', [
      { completed: false, file: 'missing.md', title: 'Missing task' }
    ]);

    await writeIndexedChange(root, 'shape-duplicate', 'open');
    await writeShapeTask(root, 'shape-duplicate', 'duplicate.md', 'Duplicate task', 'Untested.');
    await writeFile(
      join(root, 'gdd/changes/shape-duplicate/tasks.md'),
      '- [ ] [Duplicate task](tasks/duplicate.md)\n- [ ] [Duplicate task again](tasks/duplicate.md)\n'
    );

    await writeIndexedChange(root, 'shape-unindexed', 'open');
    await writeShapeTask(root, 'shape-unindexed', 'indexed.md', 'Indexed task', 'Untested.');
    await writeShapeTask(root, 'shape-unindexed', 'orphan.md', 'Orphan task', 'Untested.');
    await writeShapeTaskIndex(root, 'shape-unindexed', [
      { completed: false, file: 'indexed.md', title: 'Indexed task' }
    ]);

    const result = await status(root);
    const errors = result.invalid.map((issue) => issue.error).join(' ');

    expect(errors).toContain('missing required ## Check section');
    expect(errors).toContain('task link escapes tasks directory');
    expect(errors).toContain('linked task file is missing or invalid');
    expect(errors).toContain('duplicate task ID in tasks.md: duplicate');
    expect(errors).toContain('task is not indexed in tasks.md: orphan');
  });

  it('enforces declared task modes while preserving legacy plans', async () => {
    const root = await project();
    await init(root, ['agents'], false, '1.0.0');
    await copyFixture(root, 'decomposed-missing-index', 'decomposed-missing-index');
    await copyFixture(root, 'shape-task-plan', 'event-blue-red-themes');

    await writeIndexedChange(root, 'direct-change', 'open', 'Not yet required', 'direct');
    await writeIndexedChange(root, 'direct-with-plan', 'open', 'Not yet required', 'direct');
    await writeFile(
      join(root, 'gdd/changes/direct-with-plan/plan.md'),
      '# Plan: Invalid direct change\n'
    );

    await writeIndexedChange(root, 'legacy-plan', 'open');
    await writeFile(join(root, 'gdd/changes/legacy-plan/plan.md'), '# Plan: Legacy change\n');

    const invalidDirectory = join(root, 'gdd/changes/invalid-mode');
    await mkdir(invalidDirectory, { recursive: true });
    await writeFile(
      join(invalidDirectory, 'change.md'),
      '---\nid: invalid-mode\ntitle: Invalid mode\nstate: open\nupdated: 2026-09-09T00:00:00Z\ntaskMode: unknown\n---\n\n# Intent\n\n## Next\n\nChoose a supported mode.\n'
    );

    const result = await status(root);
    const records = new Map(result.records.map((record) => [record.id, record]));
    const errors = result.invalid.map((issue) => issue.error).join(' ');

    expect(records.get('decomposed-missing-index')).toMatchObject({
      taskMode: 'decomposed',
      tasks: { total: 0, completed: 0, open: 0, invalid: 0 }
    });
    expect(records.get('event-blue-red-themes')).toMatchObject({
      taskMode: 'decomposed',
      tasks: { total: 5, completed: 0, open: 5, invalid: 0 }
    });
    expect(records.get('direct-change')).toMatchObject({ taskMode: 'direct' });
    expect(records.get('legacy-plan')).not.toHaveProperty('taskMode');
    expect(errors).toContain('decomposed change requires a readable nonempty tasks.md');
    expect(errors).toContain('direct change cannot include plan.md; use taskMode: decomposed');
    expect(errors).toContain('taskMode must be decomposed or direct when present');
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

async function writeIndexedChange(
  root: string,
  slug: string,
  state: 'open' | 'verified',
  evidence = 'Not yet required',
  taskMode?: 'decomposed' | 'direct'
): Promise<void> {
  const directory = join(root, 'gdd', 'changes', slug);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'change.md'),
    `---\nid: ${slug}\ntitle: ${slug}\nstate: ${state}\nupdated: 2026-09-09T00:00:00Z${taskMode ? `\ntaskMode: ${taskMode}` : ''}\n---\n\n# Intent\n\n## Work\n\n[tasks](tasks.md)\n\n## Evidence\n\n${evidence}\n\n## Next\n\nContinue\n`
  );
}

async function writeIndexedTask(
  root: string,
  change: string,
  file: string,
  id: string,
  dependsOn: string[],
  evidence: string
): Promise<void> {
  const path = join(root, 'gdd', 'changes', change, 'tasks', file);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(
    path,
    `---\nid: ${id}\ntitle: ${id}\nupdated: 2026-09-09T00:00:00Z\ndependsOn: ${JSON.stringify(dependsOn)}\n---\n\n# Outcome\n\nDeliver ${id}\n\n## Acceptance and check\n\nRun ${id} test\n\n## Evidence\n\n${evidence}\n\n## Next\n\nContinue\n`
  );
}

async function writeTaskIndex(
  root: string,
  change: string,
  entries: { id: string; completed: boolean; file: string }[]
): Promise<void> {
  const directory = join(root, 'gdd', 'changes', change);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'tasks.md'),
    `# Tasks: ${change}\n\n${entries.map((entry) => `- [${entry.completed ? 'x' : ' '}] ${entry.id} ${entry.id} outcome — [details](tasks/${entry.file})`).join('\n')}\n`
  );
}

async function copyFixture(root: string, fixture: string, change: string): Promise<void> {
  await cp(join(fixtures, fixture), join(root, 'gdd/changes', change), { recursive: true });
}

async function writeShapeTask(
  root: string,
  change: string,
  file: string,
  title: string,
  evidence: string
): Promise<void> {
  const path = join(root, 'gdd/changes', change, 'tasks', file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `<!-- gdd: true -->\n# Task: ${title}\n\n## Outcome\n\nDeliver ${title}.\n\n## Dependencies\n\n- Product decision in \`change.md\`.\n\n## Check\n\nVerify ${title}.\n\n## Evidence\n\n${evidence}\n\n## Next\n\nContinue\n`
  );
}

async function writeShapeTaskIndex(
  root: string,
  change: string,
  entries: { completed: boolean; file: string; title: string }[]
): Promise<void> {
  const path = join(root, 'gdd/changes', change, 'tasks.md');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `# Tasks: ${change}\n\n${entries.map((entry) => `- [${entry.completed ? 'x' : ' '}] [${entry.title}](tasks/${entry.file})`).join('\n')}\n`
  );
}
