import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parse, stringify } from 'yaml';
import { baseFiles, isManagedContent, renderHostFiles } from './templates.js';
import type {
  ChangeRecord,
  ChangeState,
  Host,
  Manifest,
  TaskRecord,
  TaskSummary
} from './types.js';

export class GddError extends Error {}
export type Action = {
  path: string;
  status: 'created' | 'updated' | 'unchanged' | 'refused';
  message?: string;
};
const manifestPath = 'gdd/.gdd.json';

export function now(): string {
  return new Date().toISOString();
}
export function normalizeRoot(path: string): string {
  return resolve(path);
}
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function assertSafePath(root: string, relativePath: string): Promise<string> {
  const target = resolve(root, relativePath);
  if (!isInside(root, target)) throw new GddError(`Unsafe output path: ${relativePath}`);
  let cursor = root;
  for (const part of relativePath.split('/')) {
    cursor = resolve(cursor, part);
    if (await exists(cursor)) {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new GddError(`Refusing symbolic-link path: ${relativePath}`);
    }
  }
  return target;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

export async function readManifest(root: string): Promise<Manifest | undefined> {
  const path = await assertSafePath(root, manifestPath);
  const text = await readText(path);
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as Manifest;
    if (
      value.generatedBy !== 'gdd' ||
      value.schemaVersion !== 1 ||
      !Array.isArray(value.managedPaths)
    )
      throw new Error();
    return value;
  } catch {
    throw new GddError(`Invalid GDD manifest: ${manifestPath}`);
  }
}

function filesFor(hosts: Host[], version: string): Record<string, string> {
  return {
    ...baseFiles(version),
    ...hosts
      .flatMap((host) => Object.entries(renderHostFiles(host, version)))
      .reduce<Record<string, string>>((all, [path, text]) => ({ ...all, [path]: text }), {})
  };
}

async function writeManaged(
  root: string,
  files: Record<string, string>,
  force: boolean
): Promise<Action[]> {
  const actions: Action[] = [];
  for (const [relativePath, content] of Object.entries(files)) {
    const path = await assertSafePath(root, relativePath);
    const previous = await readText(path);
    if (previous === undefined) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
      actions.push({ path: relativePath, status: 'created' });
      continue;
    }
    if (!isManagedContent(previous)) {
      actions.push({ path: relativePath, status: 'refused', message: 'unmanaged collision' });
      continue;
    }
    if (previous === content) {
      actions.push({ path: relativePath, status: 'unchanged' });
      continue;
    }
    if (!force) {
      actions.push({
        path: relativePath,
        status: 'unchanged',
        message: 'managed file differs; use --force'
      });
      continue;
    }
    await writeFile(path, content, 'utf8');
    actions.push({ path: relativePath, status: 'updated' });
  }
  return actions;
}

async function writeManifest(root: string, manifest: Manifest): Promise<void> {
  const path = await assertSafePath(root, manifestPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export async function init(
  rootInput: string,
  hosts: Host[],
  force: boolean,
  version: string
): Promise<Action[]> {
  const root = normalizeRoot(rootInput);
  const prior = await readManifest(root);
  const selected = [...new Set([...(prior?.hosts ?? []), ...hosts])].sort() as Host[];
  const files = filesFor(selected, version);
  const actions = await writeManaged(root, files, force);
  const timestamp = now();
  const managedPaths = [
    ...new Set([...(prior?.managedPaths ?? []), ...Object.keys(files), manifestPath])
  ].sort();
  await writeManifest(root, {
    schemaVersion: 1,
    generatedBy: 'gdd',
    generatorVersion: version,
    hosts: selected,
    managedPaths,
    createdAt: prior?.createdAt ?? timestamp,
    updatedAt: timestamp
  });
  return actions;
}

export async function update(rootInput: string, version: string): Promise<Action[]> {
  const root = normalizeRoot(rootInput);
  const manifest = await readManifest(root);
  if (!manifest) throw new GddError('GDD is not initialized. Run gdd init first.');
  const files = filesFor(manifest.hosts, version);
  const selected = Object.fromEntries(
    manifest.managedPaths
      .filter((path) => path !== manifestPath)
      .map((path) => [path, files[path]])
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
  const actions = await writeManaged(root, selected, true);
  await writeManifest(root, { ...manifest, generatorVersion: version, updatedAt: now() });
  return actions;
}

async function findMarkdownFiles(directory: string, missingIsEmpty = false): Promise<string[]> {
  let info;
  try {
    info = await lstat(directory);
  } catch {
    if (missingIsEmpty) return [];
    throw new GddError(
      'GDD directory is missing. Run gdd init --force to repair the installation.'
    );
  }
  if (info.isSymbolicLink()) throw new GddError(`Refusing symbolic-link path: ${directory}`);
  if (!info.isDirectory()) return [];
  const { readdir } = await import('node:fs/promises');
  const children = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    children.map(async (child) => {
      const path = resolve(directory, child.name);
      if (child.isSymbolicLink()) throw new GddError(`Refusing symbolic-link path: ${path}`);
      if (child.isDirectory()) return findMarkdownFiles(path);
      return child.isFile() && child.name.endsWith('.md') ? [path] : [];
    })
  );
  return nested.flat();
}

function frontmatter(text: string): unknown {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(text);
  if (!match?.[1]) throw new GddError('missing YAML frontmatter');
  return parse(match[1]);
}
function section(text: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^${escaped}\\s*\\n+([\\s\\S]*?)(?=^#{1,6}\\s|$)`, 'm').exec(text);
  const value = match?.[1]?.trim();
  if (!value) throw new GddError(`missing required ${heading} section`);
  return value.replace(/\n+/g, ' ');
}

function hasEvidence(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    Boolean(normalized) &&
    !/<[^>]+>/.test(normalized) &&
    !/^(pending|todo|not run|tbd)\b/.test(normalized)
  );
}

function parseRecordMetadata(data: unknown): {
  id: string;
  title: string;
  state: ChangeState;
  updated: string;
  parent?: string;
} {
  if (!data || typeof data !== 'object') throw new GddError('frontmatter must be an object');
  const item = data as Record<string, unknown>;
  if (
    typeof item.id !== 'string' ||
    typeof item.title !== 'string' ||
    (item.state !== 'open' && item.state !== 'verified') ||
    typeof item.updated !== 'string'
  )
    throw new GddError('invalid required frontmatter fields');
  return {
    id: item.id,
    title: item.title,
    state: item.state,
    updated: item.updated,
    ...(typeof item.parent === 'string' ? { parent: item.parent } : {})
  };
}

function parseTask(path: string, root: string, text: string): TaskRecord {
  const metadata = parseRecordMetadata(frontmatter(text));
  const rawDependencies = (frontmatter(text) as Record<string, unknown>).dependsOn;
  if (
    !Array.isArray(rawDependencies) ||
    rawDependencies.some((dependency) => typeof dependency !== 'string')
  ) {
    throw new GddError('dependsOn must be an array of task IDs');
  }
  section(text, '# Outcome');
  section(text, '## Acceptance and check');
  const evidence = section(text, '## Evidence');
  const next = section(text, '## Next');
  if (metadata.state === 'verified' && !hasEvidence(evidence)) {
    throw new GddError('verified task requires substantive ## Evidence');
  }
  return { path: relative(root, path), ...metadata, dependsOn: rawDependencies, next };
}

export async function status(
  rootInput: string,
  state?: ChangeState
): Promise<{ records: ChangeRecord[]; invalid: { path: string; error: string }[] }> {
  const root = normalizeRoot(rootInput);
  const manifest = await readManifest(root);
  if (!manifest) throw new GddError('Invalid or missing GDD manifest. Run gdd init first.');
  const gdd = await assertSafePath(root, 'gdd');
  const paths = (await findMarkdownFiles(gdd)).filter((path) => basename(path) === 'change.md');
  const records: ChangeRecord[] = [];
  const invalid: { path: string; error: string }[] = [];
  for (const path of paths) {
    const taskErrors = new Map<string, string[]>();
    const addTaskError = (taskPath: string, error: string): void => {
      taskErrors.set(taskPath, [...(taskErrors.get(taskPath) ?? []), error]);
    };
    try {
      const text = await readFile(path, 'utf8');
      const metadata = parseRecordMetadata(frontmatter(text));
      const taskPaths = await findMarkdownFiles(resolve(dirname(path), 'tasks'), true);
      const tasks: TaskRecord[] = [];
      for (const taskPath of taskPaths) {
        try {
          const task = parseTask(taskPath, root, await readFile(taskPath, 'utf8'));
          if (tasks.some((existing) => existing.id === task.id)) {
            addTaskError(taskPath, `duplicate task ID: ${task.id}`);
          } else {
            tasks.push(task);
          }
        } catch (error) {
          addTaskError(taskPath, error instanceof Error ? error.message : String(error));
        }
      }
      const taskIds = new Map(tasks.map((task) => [task.id, task]));
      for (const task of tasks) {
        for (const dependency of task.dependsOn) {
          const dependedOn = taskIds.get(dependency);
          if (!dependedOn)
            addTaskError(resolve(root, task.path), `unknown dependency: ${dependency}`);
          else if (task.state === 'verified' && dependedOn.state !== 'verified') {
            addTaskError(
              resolve(root, task.path),
              `verified task depends on open task: ${dependency}`
            );
          }
        }
      }
      for (const [taskPath, errors] of taskErrors) {
        invalid.push({ path: relative(root, taskPath), error: errors.join('; ') });
      }
      const taskSummary: TaskSummary = {
        total: taskPaths.length,
        open: tasks.filter((task) => task.state === 'open').length,
        verified: tasks.filter((task) => task.state === 'verified').length,
        invalid: taskErrors.size
      };
      const parentIssues: string[] = [];
      if (taskPaths.length) {
        let workCoverage = '';
        try {
          workCoverage = section(text, '## Work');
        } catch {
          parentIssues.push('decomposed change requires task IDs in ## Work');
        }
        for (const task of tasks) {
          if (!workCoverage.includes(task.id))
            parentIssues.push(`task missing from ## Work: ${task.id}`);
        }
      }
      if (metadata.state === 'verified') {
        if (taskSummary.open || taskSummary.invalid)
          parentIssues.push('verified change has incomplete or invalid tasks');
        try {
          if (!hasEvidence(section(text, '## Evidence'))) {
            parentIssues.push('verified change requires substantive ## Evidence');
          }
        } catch (error) {
          parentIssues.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (parentIssues.length)
        invalid.push({ path: relative(root, path), error: parentIssues.join('; ') });
      const record: ChangeRecord = {
        path: relative(root, path),
        ...metadata,
        next: section(text, '## Next'),
        tasks: taskSummary
      };
      if (!state || record.state === state) records.push(record);
    } catch (error) {
      invalid.push({
        path: relative(root, path),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { records: records.sort((a, b) => b.updated.localeCompare(a.updated)), invalid };
}

export function formatActions(actions: Action[]): string {
  return actions
    .map(
      (action) =>
        `${action.status.padEnd(9)} ${action.path}${action.message ? ` (${action.message})` : ''}`
    )
    .join('\n');
}
export function formatStatus(records: ChangeRecord[]): string {
  return records.length
    ? records
        .map(
          (record) =>
            `${record.state.padEnd(8)} ${record.id} — ${record.title}\n  tasks: ${record.tasks.verified}/${record.tasks.total} verified${record.tasks.invalid ? `; ${record.tasks.invalid} invalid` : ''}\n  updated ${record.updated}\n  next: ${record.next}`
        )
        .join('\n')
    : 'No GDD changes found.';
}
export function manifestJson(manifest: Manifest): string {
  return stringify(manifest);
}
