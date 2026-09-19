import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
  writeFile
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parse, stringify } from 'yaml';
import { baseFiles, isManagedContent, renderHostFiles } from './templates.js';
import type {
  ArchiveSummary,
  ChangeRecord,
  ChangeState,
  Host,
  Manifest,
  StatusResult,
  TaskMode,
  TaskSummary
} from './types.js';

export class GddError extends Error {}
export type Action = {
  path: string;
  status: 'created' | 'updated' | 'unchanged' | 'refused';
  message?: string;
};
const manifestPath = 'gdd/.gdd.json';
const archiveStatePath = 'gdd/.gdd-archive.json';
const archiveJournalPath = 'gdd/.gdd-archive.pending.json';
const archiveStagingPath = 'gdd/.gdd-archive-staging';
const retiredOperationPaths = new Set([
  '.agents/skills/gdd-shape/SKILL.md',
  '.agents/skills/gdd-work/SKILL.md',
  '.github/prompts/gdd-shape.prompt.md',
  '.github/prompts/gdd-work.prompt.md'
]);

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

// Status paths are part of the CLI/API contract, so keep them stable across
// operating systems even though node:path.relative uses the host separator.
function projectRelativePath(root: string, target: string): string {
  return relative(root, target).split(sep).join('/');
}

const emptyArchiveSummary = (): ArchiveSummary => ({ changes: 0, tasks: 0 });

type ArchiveState = {
  schemaVersion: 1;
  archivedChanges: number;
  archivedTasks: number;
  lastArchivedAt?: string;
  pending?: {
    operationId: string;
    phase: 'prepared' | 'counted';
  };
};

type ArchiveJournal = {
  schemaVersion: 1;
  operationId: string;
  slug: string;
  tasks: number;
  archivedAt: string;
};

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
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

async function readOptionalFile(root: string, relativePath: string): Promise<string | undefined> {
  const path = await assertSafePath(root, relativePath);
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new GddError(`Expected a regular file: ${relativePath}`);
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isIsoUtc(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !Number.isNaN(new Date(value).getTime()) &&
    new Date(value).toISOString() === value
  );
}

function archiveSummary(state: ArchiveState | undefined): ArchiveSummary {
  if (!state) return emptyArchiveSummary();
  return {
    changes: state.archivedChanges,
    tasks: state.archivedTasks,
    ...(state.lastArchivedAt ? { lastArchivedAt: state.lastArchivedAt } : {})
  };
}

function parseArchiveState(text: string): ArchiveState {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new GddError(`Invalid archive state: ${archiveStatePath}`);
  }
  if (!value || typeof value !== 'object')
    throw new GddError(`Invalid archive state: ${archiveStatePath}`);
  const state = value as Record<string, unknown>;
  if (
    state.schemaVersion !== 1 ||
    !isNonNegativeInteger(state.archivedChanges) ||
    !isNonNegativeInteger(state.archivedTasks) ||
    (state.lastArchivedAt !== undefined && !isIsoUtc(state.lastArchivedAt))
  ) {
    throw new GddError(`Invalid archive state: ${archiveStatePath}`);
  }
  let pending: ArchiveState['pending'];
  if (state.pending !== undefined) {
    const rawPending = state.pending as Record<string, unknown>;
    if (
      !rawPending ||
      typeof rawPending.operationId !== 'string' ||
      (rawPending.phase !== 'prepared' && rawPending.phase !== 'counted')
    ) {
      throw new GddError(`Invalid archive state: ${archiveStatePath}`);
    }
    pending = { operationId: rawPending.operationId, phase: rawPending.phase };
  }
  return {
    schemaVersion: 1,
    archivedChanges: state.archivedChanges,
    archivedTasks: state.archivedTasks,
    ...(typeof state.lastArchivedAt === 'string' ? { lastArchivedAt: state.lastArchivedAt } : {}),
    ...(pending ? { pending } : {})
  };
}

async function readArchiveState(root: string): Promise<ArchiveState | undefined> {
  const text = await readOptionalFile(root, archiveStatePath);
  return text === undefined ? undefined : parseArchiveState(text);
}

function parseArchiveJournal(text: string): ArchiveJournal {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new GddError(`Invalid archive recovery journal: ${archiveJournalPath}`);
  }
  if (!value || typeof value !== 'object') {
    throw new GddError(`Invalid archive recovery journal: ${archiveJournalPath}`);
  }
  const journal = value as Record<string, unknown>;
  if (
    journal.schemaVersion !== 1 ||
    typeof journal.operationId !== 'string' ||
    !isArchiveSlug(journal.slug) ||
    !isNonNegativeInteger(journal.tasks) ||
    !isIsoUtc(journal.archivedAt)
  ) {
    throw new GddError(`Invalid archive recovery journal: ${archiveJournalPath}`);
  }
  return {
    schemaVersion: 1,
    operationId: journal.operationId,
    slug: journal.slug,
    tasks: journal.tasks,
    archivedAt: journal.archivedAt
  };
}

async function readArchiveJournal(root: string): Promise<ArchiveJournal | undefined> {
  const text = await readOptionalFile(root, archiveJournalPath);
  return text === undefined ? undefined : parseArchiveJournal(text);
}

async function writeJsonAtomically(
  root: string,
  relativePath: string,
  value: unknown
): Promise<void> {
  const path = await assertSafePath(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await assertSafePath(root, relativePath);
  const temporaryRelativePath = `${relativePath}.${randomUUID()}.tmp`;
  const temporaryPath = await assertSafePath(root, temporaryRelativePath);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, path);
  } catch (error) {
    try {
      const temporaryInfo = await lstat(temporaryPath);
      if (temporaryInfo.isFile()) await unlink(temporaryPath);
    } catch (cleanupError) {
      if (!isMissing(cleanupError)) throw cleanupError;
    }
    throw error;
  }
}

async function writeArchiveState(root: string, state: ArchiveState): Promise<void> {
  await writeJsonAtomically(root, archiveStatePath, state);
}

async function writeArchiveJournal(root: string, journal: ArchiveJournal): Promise<void> {
  await writeJsonAtomically(root, archiveJournalPath, journal);
}

async function removeRegularFile(
  root: string,
  relativePath: string,
  missingIsOkay = false
): Promise<void> {
  const path = await assertSafePath(root, relativePath);
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new GddError(`Expected a regular file: ${relativePath}`);
    await unlink(path);
  } catch (error) {
    if (missingIsOkay && isMissing(error)) return;
    throw error;
  }
}

async function assertSafeDirectoryTree(root: string, path: string): Promise<void> {
  if (!isInside(root, path)) throw new GddError(`Unsafe archive path: ${path}`);
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new GddError(`Refusing symbolic-link path: ${path}`);
  if (!info.isDirectory()) throw new GddError(`Expected a directory: ${path}`);
  for (const child of await readdir(path, { withFileTypes: true })) {
    const childPath = resolve(path, child.name);
    if (!isInside(root, childPath)) throw new GddError(`Unsafe archive path: ${childPath}`);
    const childInfo = await lstat(childPath);
    if (childInfo.isSymbolicLink()) throw new GddError(`Refusing symbolic-link path: ${childPath}`);
    if (childInfo.isDirectory()) await assertSafeDirectoryTree(root, childPath);
    else if (!childInfo.isFile()) throw new GddError(`Unsupported archive entry: ${childPath}`);
  }
}

async function removeSafeDirectoryTree(root: string, path: string): Promise<void> {
  await assertSafeDirectoryTree(root, path);
  for (const child of await readdir(path, { withFileTypes: true })) {
    const childPath = resolve(path, child.name);
    if (child.isDirectory()) await removeSafeDirectoryTree(root, childPath);
    else await unlink(childPath);
  }
  await rmdir(path);
}

function isArchiveSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(value);
}

function archiveChangePath(slug: string): string {
  return `gdd/changes/${slug}`;
}

function archiveStagedPath(slug: string): string {
  return `${archiveStagingPath}/${slug}`;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

function baseArchiveState(state: ArchiveState | undefined): ArchiveState {
  return (
    state ?? {
      schemaVersion: 1,
      archivedChanges: 0,
      archivedTasks: 0
    }
  );
}

function completeArchiveState(state: ArchiveState): ArchiveState {
  return {
    schemaVersion: 1,
    archivedChanges: state.archivedChanges,
    archivedTasks: state.archivedTasks,
    ...(state.lastArchivedAt ? { lastArchivedAt: state.lastArchivedAt } : {})
  };
}

async function createArchiveStagingDirectory(root: string): Promise<void> {
  const path = await assertSafePath(root, archiveStagingPath);
  await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (info.isSymbolicLink())
    throw new GddError(`Refusing symbolic-link path: ${archiveStagingPath}`);
  if (!info.isDirectory()) throw new GddError(`Expected a directory: ${archiveStagingPath}`);
}

async function recoverArchive(root: string): Promise<void> {
  const journal = await readArchiveJournal(root);
  const state = await readArchiveState(root);
  const stagingRoot = await assertSafePath(root, archiveStagingPath);
  const stagingExists = await exists(stagingRoot);

  if (!journal) {
    if (state?.pending) {
      throw new GddError('Archive recovery journal is missing for a pending archive operation.');
    }
    if (stagingExists) {
      const entries = await readdir(stagingRoot);
      if (entries.length)
        throw new GddError('Archive recovery is required before starting another archive.');
      await rmdir(stagingRoot);
    }
    return;
  }

  const sourceRelativePath = archiveChangePath(journal.slug);
  const stagedRelativePath = archiveStagedPath(journal.slug);
  const sourcePath = await assertSafePath(root, sourceRelativePath);
  const stagedPath = await assertSafePath(root, stagedRelativePath);
  const sourceExists = await exists(sourcePath);
  const stagedExists = await exists(stagedPath);
  if (state?.pending && state.pending.operationId !== journal.operationId) {
    throw new GddError('Archive recovery journal does not match pending archive state.');
  }
  if (sourceExists && stagedExists) {
    throw new GddError('Archive recovery found both source and staged change directories.');
  }
  if (sourceExists) {
    if (state?.pending)
      throw new GddError('Archive recovery found an unexpected pending archive state.');
    await removeRegularFile(root, archiveJournalPath);
    return;
  }
  if (!stagedExists) {
    if (state?.pending?.phase === 'counted') {
      await writeArchiveState(root, completeArchiveState(state));
      await removeRegularFile(root, archiveJournalPath);
      return;
    }
    if (!state?.pending) {
      await removeRegularFile(root, archiveJournalPath);
      return;
    }
    throw new GddError('Archive recovery cannot locate the staged change directory.');
  }

  await assertSafeDirectoryTree(root, stagedPath);
  let currentState = baseArchiveState(state);
  if (!currentState.pending) {
    currentState = {
      ...currentState,
      pending: { operationId: journal.operationId, phase: 'prepared' }
    };
    await writeArchiveState(root, currentState);
  }
  if (currentState.pending?.phase === 'prepared') {
    currentState = {
      ...currentState,
      archivedChanges: currentState.archivedChanges + 1,
      archivedTasks: currentState.archivedTasks + journal.tasks,
      lastArchivedAt: journal.archivedAt,
      pending: { operationId: journal.operationId, phase: 'counted' }
    };
    await writeArchiveState(root, currentState);
  }
  await removeSafeDirectoryTree(root, stagedPath);
  await writeArchiveState(root, completeArchiveState(currentState));
  await removeRegularFile(root, archiveJournalPath);
  if (await exists(stagingRoot)) {
    const entries = await readdir(stagingRoot);
    if (!entries.length) await rmdir(stagingRoot);
  }
}

function issueBelongsToChange(issuePath: string, slug: string): boolean {
  const directory = archiveChangePath(slug);
  return issuePath === `${directory}/change.md` || issuePath.startsWith(`${directory}/`);
}

async function archiveTaskCount(root: string, slug: string, force: boolean): Promise<number> {
  const changePath = await assertSafePath(root, archiveChangePath(slug));
  if (!(await exists(changePath))) throw new GddError(`GDD change not found: ${slug}`);
  await assertSafeDirectoryTree(root, changePath);
  if (force) return (await findMarkdownFiles(resolve(changePath, 'tasks'), true)).length;

  const result = await status(root);
  const record = result.records.find(
    (candidate) => candidate.path === `${archiveChangePath(slug)}/change.md`
  );
  if (!record) throw new GddError(`GDD change not found: ${slug}`);
  if (record.state !== 'verified')
    throw new GddError(`Only verified changes can be archived: ${slug}`);
  const issues = result.invalid.filter((issue) => issueBelongsToChange(issue.path, slug));
  if (issues.length || record.tasks.open || record.tasks.invalid) {
    throw new GddError(`GDD change must be complete and valid before archiving: ${slug}`);
  }
  return record.tasks.total;
}

export async function archive(
  rootInput: string,
  slug: string,
  confirmed: boolean,
  force = false
): Promise<ArchiveSummary> {
  if (!confirmed) throw new GddError('Archiving requires explicit confirmation.');
  if (!isArchiveSlug(slug)) throw new GddError('Archive slug must be a kebab-case change ID.');
  const root = normalizeRoot(rootInput);
  await recoverArchive(root);
  const taskCount = await archiveTaskCount(root, slug, force);
  const sourceRelativePath = archiveChangePath(slug);
  const stagedRelativePath = archiveStagedPath(slug);
  const sourcePath = await assertSafePath(root, sourceRelativePath);
  await createArchiveStagingDirectory(root);
  const stagedPath = await assertSafePath(root, stagedRelativePath);
  if (await exists(stagedPath)) throw new GddError(`Archive staging already exists for: ${slug}`);
  const journal: ArchiveJournal = {
    schemaVersion: 1,
    operationId: randomUUID(),
    slug,
    tasks: taskCount,
    archivedAt: now()
  };
  await writeArchiveJournal(root, journal);
  try {
    await rename(sourcePath, stagedPath);
  } catch (error) {
    await removeRegularFile(root, archiveJournalPath, true);
    throw error;
  }
  await recoverArchive(root);
  return archiveSummary(await readArchiveState(root));
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

function managedPathsFor(previousPaths: string[], files: Record<string, string>): string[] {
  return [
    ...new Set([
      ...previousPaths.filter((path) => !retiredOperationPaths.has(path)),
      ...Object.keys(files),
      manifestPath
    ])
  ].sort();
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
  const managedPaths = managedPathsFor(prior?.managedPaths ?? [], files);
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
  const actions = await writeManaged(root, files, true);
  await writeManifest(root, {
    ...manifest,
    generatorVersion: version,
    managedPaths: managedPathsFor(manifest.managedPaths, files),
    updatedAt: now()
  });
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
    !/^(pending|todo|not run|untested|blocked|tbd)\b/.test(normalized)
  );
}

function parseRecordMetadata(data: unknown): {
  id: string;
  title: string;
  state: ChangeState;
  updated: string;
  parent?: string;
  taskMode?: TaskMode;
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
  if (item.taskMode !== undefined && item.taskMode !== 'decomposed' && item.taskMode !== 'direct') {
    throw new GddError('taskMode must be decomposed or direct when present');
  }
  return {
    id: item.id,
    title: item.title,
    state: item.state,
    updated: item.updated,
    ...(typeof item.parent === 'string' ? { parent: item.parent } : {}),
    ...(item.taskMode === 'decomposed' || item.taskMode === 'direct'
      ? { taskMode: item.taskMode }
      : {})
  };
}

type TaskFormat = 'canonical' | 'shape';
type ParsedTask = {
  path: string;
  id: string;
  title: string;
  state?: ChangeState;
  dependsOn: string[];
  next: string;
  evidence: string;
  format: TaskFormat;
};
type TaskIndexEntry = {
  id: string;
  completed: boolean;
  path: string;
  format: TaskFormat;
};

function shapeTaskId(tasksDirectory: string, path: string): string {
  const taskPath = relative(tasksDirectory, path);
  if (!taskPath || taskPath.startsWith(`..${sep}`) || taskPath === '..') {
    throw new GddError(`task path escapes tasks directory: ${path}`);
  }
  if (!taskPath.endsWith('.md')) throw new GddError(`task record is not Markdown: ${taskPath}`);
  return taskPath.slice(0, -'.md'.length).split(sep).join('/');
}

function parseCanonicalTask(
  path: string,
  root: string,
  text: string,
  requireState: boolean
): ParsedTask {
  const raw = frontmatter(text);
  if (!raw || typeof raw !== 'object') throw new GddError('frontmatter must be an object');
  const item = raw as Record<string, unknown>;
  if (
    typeof item.id !== 'string' ||
    typeof item.title !== 'string' ||
    typeof item.updated !== 'string'
  ) {
    throw new GddError('invalid required task frontmatter fields');
  }
  const state = item.state;
  if (requireState && state !== 'open' && state !== 'verified') {
    throw new GddError('legacy task requires state: open or verified');
  }
  if (state !== undefined && state !== 'open' && state !== 'verified') {
    throw new GddError('task state must be open or verified when present');
  }
  const rawDependencies = item.dependsOn;
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
  return {
    path: projectRelativePath(root, path),
    id: item.id,
    title: item.title,
    ...(state === 'open' || state === 'verified' ? { state } : {}),
    dependsOn: rawDependencies,
    next,
    evidence,
    format: 'canonical'
  };
}

function parseShapeTask(
  path: string,
  root: string,
  tasksDirectory: string,
  text: string
): ParsedTask {
  const titleMatch = /^# Task:\s*(.+?)\s*$/m.exec(text);
  const title = titleMatch?.[1]?.trim();
  if (!title) throw new GddError('unsupported task record format');
  section(text, '## Outcome');
  section(text, '## Dependencies');
  section(text, '## Check');
  const evidence = section(text, '## Evidence');
  const next = section(text, '## Next');
  return {
    path: projectRelativePath(root, path),
    id: shapeTaskId(tasksDirectory, path),
    title,
    dependsOn: [],
    next,
    evidence,
    format: 'shape'
  };
}

function parseTask(
  path: string,
  root: string,
  tasksDirectory: string,
  text: string,
  requireState: boolean
): ParsedTask {
  if (/^---\s*\n/.test(text)) return parseCanonicalTask(path, root, text, requireState);
  if (requireState) return parseCanonicalTask(path, root, text, requireState);
  return parseShapeTask(path, root, tasksDirectory, text);
}

async function parseTaskIndex(
  root: string,
  indexPath: string,
  tasksDirectory: string,
  text: string
): Promise<TaskIndexEntry[]> {
  const entries: TaskIndexEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trimStart().startsWith('- [')) continue;
    const canonical =
      /^\s*-\s+\[([ xX])\]\s+([A-Za-z0-9][A-Za-z0-9_-]*)\s+.+?\s+—\s+\[[^\]]+\]\(([^)]+)\)\s*$/.exec(
        line
      );
    const shape = /^\s*-\s+\[([ xX])\]\s+\[[^\]]+\]\(([^)]+)\)\s*$/.exec(line);
    const match = canonical ?? shape;
    if (!match?.[1] || !match[2]) {
      throw new GddError('malformed task checkbox entry');
    }
    const link = canonical ? canonical[3] : shape?.[2];
    if (!link) throw new GddError('malformed task checkbox entry');
    const target = resolve(dirname(indexPath), link);
    if (!isInside(tasksDirectory, target)) {
      throw new GddError(`task link escapes tasks directory: ${link}`);
    }
    await assertSafePath(root, relative(root, target));
    const id = canonical?.[2] ?? shapeTaskId(tasksDirectory, target);
    if (entries.some((entry) => entry.id === id)) {
      throw new GddError(`duplicate task ID in tasks.md: ${id}`);
    }
    if (entries.some((entry) => entry.path === target)) {
      throw new GddError(`duplicate task link in tasks.md: ${link}`);
    }
    entries.push({
      id,
      completed: match[1].toLowerCase() === 'x',
      path: target,
      format: canonical ? 'canonical' : 'shape'
    });
  }
  if (!entries.length) throw new GddError('tasks.md contains no task checkbox entries');
  return entries;
}

export async function status(rootInput: string, state?: ChangeState): Promise<StatusResult> {
  const root = normalizeRoot(rootInput);
  const manifest = await readManifest(root);
  if (!manifest) throw new GddError('Invalid or missing GDD manifest. Run gdd init first.');
  const gdd = await assertSafePath(root, 'gdd');
  const records: ChangeRecord[] = [];
  const invalid: { path: string; error: string }[] = [];
  let archive = emptyArchiveSummary();
  try {
    const archiveState = await readArchiveState(root);
    archive = archiveSummary(archiveState);
    if (archiveState?.pending) {
      invalid.push({
        path: archiveStatePath,
        error: 'archive recovery is required before the aggregate state is final'
      });
    }
  } catch (error) {
    invalid.push({
      path: archiveStatePath,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  const paths = (await findMarkdownFiles(gdd)).filter((path) => {
    const firstSegment = relative(gdd, path).split(sep)[0];
    return basename(path) === 'change.md' && firstSegment !== '.gdd-archive-staging';
  });
  for (const path of paths) {
    const taskErrors = new Map<string, string[]>();
    const addTaskError = (taskPath: string, error: string): void => {
      taskErrors.set(taskPath, [...(taskErrors.get(taskPath) ?? []), error]);
    };
    try {
      const text = await readFile(path, 'utf8');
      const metadata = parseRecordMetadata(frontmatter(text));
      const changeDirectory = dirname(path);
      const tasksDirectory = resolve(changeDirectory, 'tasks');
      const taskPaths = await findMarkdownFiles(tasksDirectory, true);
      const indexPath = resolve(changeDirectory, 'tasks.md');
      const hasIndex = await exists(indexPath);
      if (hasIndex) await assertSafePath(root, relative(root, indexPath));
      const planPath = resolve(changeDirectory, 'plan.md');
      const hasPlan = await exists(planPath);
      if (hasPlan) await assertSafePath(root, relative(root, planPath));
      const tasks: ParsedTask[] = [];
      for (const taskPath of taskPaths) {
        try {
          const task = parseTask(
            taskPath,
            root,
            tasksDirectory,
            await readFile(taskPath, 'utf8'),
            !hasIndex
          );
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
      let taskSummary: TaskSummary;
      const parentIssues: string[] = [];
      let hasValidTaskIndex = false;
      if (hasIndex) {
        let entries: TaskIndexEntry[] = [];
        try {
          entries = await parseTaskIndex(
            root,
            indexPath,
            tasksDirectory,
            await readFile(indexPath, 'utf8')
          );
          hasValidTaskIndex = true;
        } catch (error) {
          addTaskError(indexPath, error instanceof Error ? error.message : String(error));
        }
        const tasksByPath = new Map(tasks.map((task) => [resolve(root, task.path), task]));
        const indexedPaths = new Set<string>();
        const completedIds = new Set(
          entries.filter((entry) => entry.completed).map((entry) => entry.id)
        );
        for (const entry of entries) {
          indexedPaths.add(entry.path);
          const task = tasksByPath.get(entry.path);
          if (!task) {
            addTaskError(
              indexPath,
              `linked task file is missing or invalid: ${relative(changeDirectory, entry.path)}`
            );
            continue;
          }
          if (task.id !== entry.id) {
            addTaskError(entry.path, `checkbox ID ${entry.id} does not match task ID ${task.id}`);
          }
          if (entry.completed && !hasEvidence(task.evidence)) {
            addTaskError(entry.path, 'checked task requires substantive ## Evidence');
          }
          if (task.format === 'canonical') {
            for (const dependency of task.dependsOn) {
              if (!taskIds.has(dependency))
                addTaskError(entry.path, `unknown dependency: ${dependency}`);
              else if (entry.completed && !completedIds.has(dependency)) {
                addTaskError(entry.path, `checked task depends on unchecked task: ${dependency}`);
              }
            }
          }
        }
        for (const task of tasks) {
          const absolutePath = resolve(root, task.path);
          if (!indexedPaths.has(absolutePath))
            addTaskError(absolutePath, `task is not indexed in tasks.md: ${task.id}`);
        }
        taskSummary = {
          total: entries.length,
          open: entries.filter((entry) => !entry.completed).length,
          completed: entries.filter((entry) => entry.completed).length,
          invalid: taskErrors.size
        };
      } else {
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
          if (task.state === 'verified' && !hasEvidence(task.evidence)) {
            addTaskError(
              resolve(root, task.path),
              'verified task requires substantive ## Evidence'
            );
          }
        }
        taskSummary = {
          total: taskPaths.length,
          open: tasks.filter((task) => task.state === 'open').length,
          completed: tasks.filter((task) => task.state === 'verified').length,
          invalid: taskErrors.size
        };
      }
      if (metadata.taskMode === 'decomposed' && !hasValidTaskIndex) {
        parentIssues.push('decomposed change requires a readable nonempty tasks.md');
      }
      if (metadata.taskMode === 'direct' && hasPlan) {
        parentIssues.push('direct change cannot include plan.md; use taskMode: decomposed');
      }
      if (!hasIndex && taskPaths.length) {
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
      for (const [taskPath, errors] of taskErrors) {
        invalid.push({ path: projectRelativePath(root, taskPath), error: errors.join('; ') });
      }
      if (parentIssues.length)
        invalid.push({ path: projectRelativePath(root, path), error: parentIssues.join('; ') });
      const record: ChangeRecord = {
        path: projectRelativePath(root, path),
        ...metadata,
        next: section(text, '## Next'),
        tasks: taskSummary
      };
      if (!state || record.state === state) records.push(record);
    } catch (error) {
      invalid.push({
        path: projectRelativePath(root, path),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { records: records.sort((a, b) => b.updated.localeCompare(a.updated)), invalid, archive };
}

export function formatActions(actions: Action[]): string {
  return actions
    .map(
      (action) =>
        `${action.status.padEnd(9)} ${action.path}${action.message ? ` (${action.message})` : ''}`
    )
    .join('\n');
}
export function manifestJson(manifest: Manifest): string {
  return stringify(manifest);
}
