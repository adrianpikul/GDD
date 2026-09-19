import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { archive, GddError, init, isInside, readManifest, status, update } from '../src/core.js';
import { formatStatus, formatStatusIssues, shouldUseStatusColor } from '../src/status-view.js';
import type { StatusResult } from '../src/types.js';

const roots: string[] = [];
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const operationPaths = {
  agents: {
    legacy: ['.agents/skills/gdd-shape/SKILL.md', '.agents/skills/gdd-work/SKILL.md'],
    canonical: [
      '.agents/skills/gdd-design/SKILL.md',
      '.agents/skills/gdd-design-update/SKILL.md',
      '.agents/skills/gdd-build/SKILL.md',
      '.agents/skills/gdd-archive/SKILL.md'
    ]
  },
  github: {
    legacy: ['.github/prompts/gdd-shape.prompt.md', '.github/prompts/gdd-work.prompt.md'],
    canonical: [
      '.github/prompts/gdd-design.prompt.md',
      '.github/prompts/gdd-design-update.prompt.md',
      '.github/prompts/gdd-build.prompt.md',
      '.github/prompts/gdd-archive.prompt.md'
    ]
  }
} as const;
type OperationHost = keyof typeof operationPaths;

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gdd-test-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function pathsFor(hosts: OperationHost[], kind: 'legacy' | 'canonical'): string[] {
  return hosts.flatMap((host) => operationPaths[host][kind]);
}

async function seedLegacyInstallation(
  root: string,
  hosts: OperationHost[]
): Promise<Map<string, string>> {
  await init(root, hosts, false, '1.0.0');
  await Promise.all(
    pathsFor(hosts, 'canonical').map((path) => rm(join(root, path), { force: true }))
  );

  const legacyContents = new Map<string, string>();
  for (const path of pathsFor(hosts, 'legacy')) {
    const content = `<!-- gdd: true -->\nlegacy ${path}\n`;
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
    legacyContents.set(path, content);
  }

  const manifest = await readManifest(root);
  if (!manifest) throw new Error('Expected a generated manifest');
  await writeFile(
    join(root, 'gdd/.gdd.json'),
    `${JSON.stringify(
      {
        ...manifest,
        managedPaths: [
          ...new Set([
            ...manifest.managedPaths.filter((path) => !pathsFor(hosts, 'canonical').includes(path)),
            ...legacyContents.keys()
          ])
        ].sort()
      },
      null,
      2
    )}\n`
  );
  return legacyContents;
}

describe('GDD generation', () => {
  it('initializes both host integrations and persists a manifest', async () => {
    const root = await project();
    const actions = await init(root, ['agents', 'github'], false, '1.2.3');
    expect(actions.filter((action) => action.status === 'created')).toHaveLength(16);
    expect(await readManifest(root)).toMatchObject({
      generatorVersion: '1.2.3',
      hosts: ['agents', 'github']
    });
    expect(await readFile(join(root, '.github/prompts/gdd-build.prompt.md'), 'utf8')).toContain(
      'name: gdd-build'
    );
    expect(await readFile(join(root, '.agents/skills/gdd-check/SKILL.md'), 'utf8')).toContain(
      '# Check'
    );
    expect(await readFile(join(root, '.agents/skills/gdd-archive/SKILL.md'), 'utf8')).toContain(
      '# Archive'
    );
    expect(
      await readFile(join(root, '.agents/skills/gdd-design-update/SKILL.md'), 'utf8')
    ).toContain('name: gdd-design-update');
    expect(
      await readFile(join(root, '.agents/skills/gdd-design-update/SKILL.md'), 'utf8')
    ).toContain('gddVersion: "1.2.3"');
    expect(
      await readFile(join(root, '.github/prompts/gdd-design-update.prompt.md'), 'utf8')
    ).toContain('name: gdd-design-update');
    expect(
      await readFile(join(root, '.github/prompts/gdd-design-update.prompt.md'), 'utf8')
    ).toContain("agent: 'agent'");
    const designUpdatePrompt = await readFile(
      join(root, '.github/prompts/gdd-design-update.prompt.md'),
      'utf8'
    );
    for (const boundary of [
      'Require both feedback and a selected existing',
      'do not edit application source, tests, or product configuration',
      'Treat the feedback as current user intent',
      'migrate it in place to `taskMode: decomposed`',
      'leave newly created checkboxes unchecked until implementation evidence exists',
      'tasks.md` is the sole completion state',
      'Do not leave duplicate links, orphan task records',
      'uncheck only that affected task',
      'Run read-only `gdd status` when available',
      'Do not implement, repair source, weaken acceptance'
    ]) {
      expect(designUpdatePrompt).toContain(boundary);
    }
    expect(await readFile(join(root, 'gdd/templates/task.template.md'), 'utf8')).toContain(
      'dependsOn: []'
    );
    expect(await readFile(join(root, 'gdd/templates/tasks.template.md'), 'utf8')).toContain(
      'Checkbox state is authoritative'
    );
    for (const path of [
      '.github/prompts/gdd-design.prompt.md',
      '.agents/skills/gdd-design/SKILL.md'
    ]) {
      const design = await readFile(join(root, path), 'utf8');
      expect(design).toContain('Every new change, including one with exactly one bounded');
      expect(design).toContain('set `taskMode: decomposed`');
      expect(design).toContain('tasks/<stable-id>-<slug>.md');
      expect(design).toContain('Use this exact canonical wire format');
      expect(design).toContain('id: T001');
      expect(design).not.toContain('use `direct` only');
    }
    const router = await readFile(join(root, '.github/prompts/gdd.prompt.md'), 'utf8');
    for (const route of [
      'feedback or revise a selected existing GDD change uses Design Update',
      'new, planning-only, or exploratory requests use Design',
      'verification-only requests use Check',
      'delivery, modification, or resume requests use Build',
      'close, archive, or prune a selected verified GDD change uses Archive'
    ]) {
      expect(router).toContain(route);
    }
    await expect(
      readFile(join(root, '.github/prompts/gdd-shape.prompt.md'), 'utf8')
    ).rejects.toThrow();
    await expect(
      readFile(join(root, '.agents/skills/gdd-work/SKILL.md'), 'utf8')
    ).rejects.toThrow();
    expect(await readFile(join(root, 'gdd/README.md'), 'utf8')).toContain('**Design Update**');
    expect(await readFile(join(root, 'gdd/README.md'), 'utf8')).toContain(
      'three authority boundaries'
    );
    expect(await readFile(join(root, 'gdd/README.md'), 'utf8')).toContain('**Work**');
    expect(await readFile(join(root, 'gdd/README.md'), 'utf8')).toContain(
      'Every new change uses `taskMode: decomposed`, including a one-action change.'
    );
    expect(await readFile(join(root, 'gdd/README.md'), 'utf8')).toContain('gdd archive <slug>');
    expect(await readFile(join(root, 'gdd/templates/change.template.md'), 'utf8')).toContain(
      'taskMode: decomposed'
    );
    expect(await readFile(join(root, 'gdd/templates/change.template.md'), 'utf8')).not.toContain(
      'direct'
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

  it('creates the Design Update asset for each selected host combination', async () => {
    const scenarios: { hosts: OperationHost[]; paths: string[] }[] = [
      { hosts: ['agents'], paths: ['.agents/skills/gdd-design-update/SKILL.md'] },
      { hosts: ['github'], paths: ['.github/prompts/gdd-design-update.prompt.md'] },
      {
        hosts: ['agents', 'github'],
        paths: [
          '.agents/skills/gdd-design-update/SKILL.md',
          '.github/prompts/gdd-design-update.prompt.md'
        ]
      }
    ];

    for (const scenario of scenarios) {
      const root = await project();
      await init(root, scenario.hosts, false, '1.2.3');
      for (const path of scenario.paths) {
        const content = await readFile(join(root, path), 'utf8');
        expect(content).toContain('gdd: true');
        expect(content).toContain('# Design Update');
        expect(content).toContain('Design Update is a specialization of Design');
      }
    }
  });

  it('creates the Archive asset with safety guidance for each selected host combination', async () => {
    const scenarios: { hosts: OperationHost[]; paths: string[] }[] = [
      { hosts: ['agents'], paths: ['.agents/skills/gdd-archive/SKILL.md'] },
      { hosts: ['github'], paths: ['.github/prompts/gdd-archive.prompt.md'] },
      {
        hosts: ['agents', 'github'],
        paths: ['.agents/skills/gdd-archive/SKILL.md', '.github/prompts/gdd-archive.prompt.md']
      }
    ];

    for (const scenario of scenarios) {
      const root = await project();
      await init(root, scenario.hosts, false, '1.2.3');
      for (const path of scenario.paths) {
        const content = await readFile(join(root, path), 'utf8');
        expect(content).toContain('gdd: true');
        expect(content).toContain('# Archive');
        expect(content).toContain("Require the user's explicit confirmation");
        expect(content).toContain('never manually delete the directory');
      }
    }
  });

  it('refuses unmanaged collisions even with force', async () => {
    const root = await project();
    await mkdir(join(root, '.github/prompts'), { recursive: true });
    await writeFile(join(root, '.github/prompts/gdd-build.prompt.md'), 'user content');
    const actions = await init(root, ['github'], true, '1.0.0');
    expect(actions.find((action) => action.path.endsWith('gdd-build.prompt.md'))).toMatchObject({
      status: 'refused'
    });
    expect(await readFile(join(root, '.github/prompts/gdd-build.prompt.md'), 'utf8')).toBe(
      'user content'
    );
  });

  it('refreshes differing owned content only with force', async () => {
    const root = await project();
    await init(root, ['agents'], false, '1.0.0');
    const path = join(root, '.agents/skills/gdd-build/SKILL.md');
    await writeFile(path, '---\ngdd: true\n---\nold');
    expect(
      (await init(root, ['agents'], false, '1.0.0')).find((action) =>
        action.path.endsWith('gdd-build/SKILL.md')
      )
    ).toMatchObject({ status: 'unchanged' });
    expect(
      (await init(root, ['agents'], true, '1.0.0')).find((action) =>
        action.path.endsWith('gdd-build/SKILL.md')
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

  it('migrates legacy operation assets during update without changing their contents', async () => {
    const root = await project();
    const hosts: OperationHost[] = ['agents', 'github'];
    const legacyContents = await seedLegacyInstallation(root, hosts);

    const actions = await update(root, '2.0.0');

    for (const path of pathsFor(hosts, 'canonical')) {
      expect(actions.find((action) => action.path === path)).toMatchObject({ status: 'created' });
      expect(await readFile(join(root, path), 'utf8')).toContain('gdd: true');
    }
    for (const [path, content] of legacyContents) {
      expect(await readFile(join(root, path), 'utf8')).toBe(content);
    }
    const manifest = await readManifest(root);
    expect(manifest?.managedPaths).toEqual(expect.not.arrayContaining(pathsFor(hosts, 'legacy')));
    expect(manifest?.managedPaths).toEqual(expect.arrayContaining(pathsFor(hosts, 'canonical')));
    expect(
      (await update(root, '2.0.0')).some((action) =>
        pathsFor(hosts, 'legacy').includes(action.path)
      )
    ).toBe(false);
  });

  it('retires legacy operation paths during forced initialization', async () => {
    const root = await project();
    const legacyContents = await seedLegacyInstallation(root, ['agents']);

    const actions = await init(root, ['agents'], true, '2.0.0');

    expect(
      actions.find((action) => action.path === '.agents/skills/gdd-design/SKILL.md')
    ).toMatchObject({ status: 'created' });
    for (const [path, content] of legacyContents) {
      expect(await readFile(join(root, path), 'utf8')).toBe(content);
    }
    expect((await readManifest(root))?.managedPaths).toEqual(
      expect.not.arrayContaining(pathsFor(['agents'], 'legacy'))
    );
  });

  it('refuses an unmanaged canonical collision without touching legacy assets', async () => {
    const root = await project();
    const legacyContents = await seedLegacyInstallation(root, ['agents']);
    const destination = join(root, '.agents/skills/gdd-design/SKILL.md');
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, 'user content');

    const actions = await update(root, '2.0.0');

    expect(
      actions.find((action) => action.path === '.agents/skills/gdd-design/SKILL.md')
    ).toMatchObject({ status: 'refused' });
    expect(await readFile(destination, 'utf8')).toBe('user content');
    for (const [path, content] of legacyContents) {
      expect(await readFile(join(root, path), 'utf8')).toBe(content);
    }
  });

  it('refuses a user-owned Design Update path during update', async () => {
    const root = await project();
    await init(root, ['agents'], false, '1.0.0');
    const destination = join(root, '.agents/skills/gdd-design-update/SKILL.md');
    await writeFile(destination, 'user content');

    const actions = await update(root, '2.0.0');

    expect(
      actions.find((action) => action.path === '.agents/skills/gdd-design-update/SKILL.md')
    ).toMatchObject({
      status: 'refused'
    });
    expect(await readFile(destination, 'utf8')).toBe('user content');
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
    const archivePath = join(root, '.agents/skills/gdd-archive/SKILL.md');
    await rm(templatePath);
    await rm(archivePath);
    await update(root, '2.0.0');
    expect(await readFile(templatePath, 'utf8')).toContain('Checkbox state is authoritative');
    expect(await readFile(archivePath, 'utf8')).toContain('# Archive');
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
    expect(formatStatus(result).output).toContain('0 / 5 tasks complete');
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
    expect(records.get('direct-change')).toMatchObject({
      taskMode: 'direct',
      tasks: { total: 0, completed: 0, open: 0, invalid: 0 }
    });
    expect(records.get('legacy-plan')).not.toHaveProperty('taskMode');
    expect(errors).toContain('decomposed change requires a readable nonempty tasks.md');
    expect(errors).toContain('direct change cannot include plan.md; use taskMode: decomposed');
    expect(errors).toContain('taskMode must be decomposed or direct when present');

    const directPath = join(root, 'gdd/changes/direct-change/change.md');
    const directBefore = await readFile(directPath, 'utf8');
    await update(root, '2.0.0');
    expect(await readFile(directPath, 'utf8')).toBe(directBefore);
    const afterUpdate = await status(root);
    expect(afterUpdate.records.find((record) => record.id === 'direct-change')).toMatchObject({
      taskMode: 'direct',
      tasks: { total: 0, completed: 0, open: 0, invalid: 0 }
    });
    expect(formatStatus(afterUpdate).output).toContain('Progress  — no task breakdown');
  });
});

describe('archive', () => {
  it('removes a verified canonical change and retains aggregate-only totals', async () => {
    const root = await project();
    await init(root, ['agents'], false, '1.0.0');
    await writeCompleteIndexedChange(root, 'completed-change', 2);

    const firstArchive = await archive(root, 'completed-change', true);

    expect(firstArchive).toMatchObject({ changes: 1, tasks: 2 });
    expect(firstArchive.lastArchivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*\.\d{3}Z$/);
    await expect(
      readFile(join(root, 'gdd/changes/completed-change/change.md'), 'utf8')
    ).rejects.toThrow();
    const state = JSON.parse(await readFile(join(root, 'gdd/.gdd-archive.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(state).toMatchObject({ schemaVersion: 1, archivedChanges: 1, archivedTasks: 2 });
    expect(JSON.stringify(state)).not.toContain('completed-change');
    const stateText = await readFile(join(root, 'gdd/.gdd-archive.json'), 'utf8');
    await update(root, '2.0.0');
    expect(await readFile(join(root, 'gdd/.gdd-archive.json'), 'utf8')).toBe(stateText);

    await writeIndexedChange(
      root,
      'legacy-verified',
      'verified',
      'integration test passed',
      'direct'
    );
    const secondArchive = await archive(root, 'legacy-verified', true);

    expect(secondArchive).toMatchObject({ changes: 2, tasks: 2 });
    expect((await status(root)).records).toEqual([]);
    expect((await status(root)).archive).toMatchObject({ changes: 2, tasks: 2 });
  });

  it('requires acknowledgement and refuses unknown, open, incomplete, and unsafe changes', async () => {
    const root = await project();
    const outside = await project();
    await init(root, ['agents'], false, '1.0.0');
    await writeCompleteIndexedChange(root, 'confirmed-change', 1);
    await writeIndexedChange(root, 'open-change', 'open', 'pending work', 'direct');
    await writeIndexedChange(
      root,
      'incomplete-change',
      'verified',
      'integration test passed',
      'decomposed'
    );

    await expect(archive(root, 'confirmed-change', false)).rejects.toThrow('explicit confirmation');
    await expect(archive(root, 'missing-change', true)).rejects.toThrow('not found');
    await expect(archive(root, 'open-change', true)).rejects.toThrow('Only verified changes');
    await expect(archive(root, 'incomplete-change', true)).rejects.toThrow(
      'complete and valid before archiving'
    );
    await expect(archive(root, '../outside', true)).rejects.toThrow('kebab-case');
    await mkdir(join(outside, 'linked-change'), { recursive: true });
    await writeFile(join(outside, 'linked-change/keep.md'), 'outside content');
    await symlink(outside + '/linked-change', join(root, 'gdd/changes/linked-change'));
    await expect(archive(root, 'linked-change', true)).rejects.toBeInstanceOf(GddError);

    expect(await readFile(join(root, 'gdd/changes/confirmed-change/change.md'), 'utf8')).toContain(
      'confirmed-change'
    );
    expect(await readFile(join(outside, 'linked-change/keep.md'), 'utf8')).toBe('outside content');
    await rm(join(root, 'gdd/changes/linked-change'));
    expect((await status(root)).archive).toEqual({ changes: 0, tasks: 0 });
  });

  it('force archives a selected change with validation issues while preserving path safety', async () => {
    const root = await project();
    await init(root, ['agents'], false, '1.0.0');
    const changeDirectory = join(root, 'gdd/changes/broken-change');
    await mkdir(join(changeDirectory, 'tasks'), { recursive: true });
    await writeFile(join(changeDirectory, 'change.md'), 'This record is intentionally malformed.\n');
    await writeFile(join(changeDirectory, 'tasks/reconcile.md'), '# Incomplete task\n');

    await expect(archive(root, 'broken-change', false, true)).rejects.toThrow(
      'explicit confirmation'
    );
    await expect(archive(root, 'broken-change', true)).rejects.toThrow('GDD change not found');

    const totals = await archive(root, 'broken-change', true, true);

    expect(totals).toMatchObject({ changes: 1, tasks: 1 });
    await expect(readFile(join(changeDirectory, 'change.md'), 'utf8')).rejects.toThrow();
  });

  it('recovers a staged archive exactly once and reports malformed aggregate state', async () => {
    const root = await project();
    await init(root, ['agents'], false, '1.0.0');
    const staging = join(root, 'gdd/.gdd-archive-staging/recovered-change');
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, 'change.md'), 'archived staging data');
    await writeFile(
      join(root, 'gdd/.gdd-archive.pending.json'),
      '{\n  "schemaVersion": 1,\n  "operationId": "recovery-test",\n  "slug": "recovered-change",\n  "tasks": 3,\n  "archivedAt": "2026-09-10T12:00:00.000Z"\n}\n'
    );

    await expect(archive(root, 'missing-change', true)).rejects.toThrow('not found');
    expect((await status(root)).archive).toEqual({
      changes: 1,
      tasks: 3,
      lastArchivedAt: '2026-09-10T12:00:00.000Z'
    });
    await expect(readFile(join(root, 'gdd/.gdd-archive.pending.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(staging, 'change.md'), 'utf8')).rejects.toThrow();

    await writeFile(join(root, 'gdd/.gdd-archive.json'), '{ not JSON }\n');
    const result = await status(root);
    expect(result.archive).toEqual({ changes: 0, tasks: 0 });
    expect(result.invalid).toContainEqual({
      path: 'gdd/.gdd-archive.json',
      error: 'Invalid archive state: gdd/.gdd-archive.json'
    });
    expect(await readFile(join(root, 'gdd/.gdd-archive.json'), 'utf8')).toBe('{ not JSON }\n');
  });
});

describe('status presentation', () => {
  const result: StatusResult = {
    records: [
      {
        path: 'gdd/changes/add-mint-orange-themes/change.md',
        id: 'add-mint-orange-themes',
        title: 'Add red and orange application themes',
        state: 'open',
        updated: '2026-09-10T11:28:50Z',
        next: 'Run GDD Build to verify T003.',
        tasks: { total: 3, open: 1, completed: 2, invalid: 1 }
      },
      {
        path: 'gdd/changes/update-readme/change.md',
        id: 'update-readme',
        title: 'Update the README',
        state: 'verified',
        updated: 'not-a-date',
        next: 'No further action.',
        tasks: { total: 0, open: 0, completed: 0, invalid: 0 }
      }
    ],
    invalid: [{ path: 'gdd/changes/broken/change.md', error: 'missing YAML frontmatter' }],
    archive: { changes: 4, tasks: 11, lastArchivedAt: '2026-09-10T12:00:00.000Z' }
  };

  it('renders a readable, bounded plain status view and issues view', () => {
    const presentation = formatStatus(result);

    expect(presentation.output).toBe(`GDD status
──────────
2 changes · 1 open · 1 verified
Archived  4 changes resolved · 11 tasks completed

OPEN  Add red and orange application themes
      add-mint-orange-themes
      Progress  [███████░░░] 2 / 3 tasks complete · 1 invalid task
      Updated   2026-09-10 11:28 UTC
      Next      Run GDD Build to verify T003.

VERIFIED  Update the README
      update-readme
      Progress  — no task breakdown
      Updated   not-a-date
      Next      No further action.`);
    expect(presentation.issues).toBe(`GDD issues
──────────
1 invalid record

! gdd/changes/broken/change.md
  missing YAML frontmatter`);
    expect(presentation.output).not.toContain('\u001B[');
    expect(presentation.issues).not.toContain('\u001B[');
  });

  it('keeps large task progress bounded and shows an empty state', () => {
    const large: StatusResult = {
      records: [
        {
          ...result.records[0]!,
          tasks: { total: 100, open: 50, completed: 50, invalid: 0 }
        }
      ],
      invalid: [],
      archive: { changes: 0, tasks: 0 }
    };

    expect(formatStatus(large).output).toContain('[█████░░░░░] 50 / 100 tasks complete');
    expect(formatStatus({ records: [], invalid: [], archive: { changes: 0, tasks: 0 } }).output)
      .toBe(`GDD status
──────────
0 changes
Archived  0 changes resolved · 0 tasks completed

No GDD changes found.`);
  });

  it('adds ANSI styling only when explicitly requested', () => {
    const styled = formatStatus(result, { color: true });

    expect(styled.output).toContain('\u001B[');
    expect(styled.issues).toContain('\u001B[');
    expect(formatStatusIssues([], { color: true })).toBe('');
    expect(shouldUseStatusColor(true, undefined)).toBe(true);
    expect(shouldUseStatusColor(false, undefined)).toBe(false);
    expect(shouldUseStatusColor(true, '')).toBe(false);
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

async function writeCompleteIndexedChange(
  root: string,
  slug: string,
  taskCount: number
): Promise<void> {
  await writeIndexedChange(root, slug, 'verified', 'integration test passed', 'decomposed');
  const entries = Array.from({ length: taskCount }, (_, index) => {
    const id = `T${String(index + 1).padStart(3, '0')}`;
    return { id, completed: true, file: `${id}-work.md` };
  });
  for (const entry of entries) {
    await writeIndexedTask(root, slug, entry.file, entry.id, [], `${entry.id} check passed`);
  }
  await writeTaskIndex(root, slug, entries);
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
