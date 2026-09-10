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
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parse, stringify } from 'yaml';
import { GddError } from './contracts.js';
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

export { GddError } from './contracts.js';
export type Action = {
  path: string;
  status: 'created' | 'updated' | 'unchanged' | 'refused';
  message?: string;
};
const manifestPath = 'gdd/.gdd.json';
const archiveStatePath = 'gdd/.gdd-archive.json';
const archiveJournalPath = 'gdd/.gdd-archive.pending.json';
const archiveStagingPath = 'gdd/.gdd-archive-staging';
const operationLockPath = 'gdd/.gdd-operation.lock';
const managedJournalPath = 'gdd/.gdd-managed.pending.json';
const managedStagingPath = 'gdd/.gdd-managed-staging';
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

type OperationName = 'archive' | 'init' | 'update';
type OperationLease = {
  operationId: string;
  command: OperationName;
  startedAt: string;
  pid: number;
};
type ManagedWrite = {
  path: string;
  content: string;
};
type ManagedWriteJournal = {
  schemaVersion: 1;
  operationId: string;
  command: 'init' | 'update';
  createdAt: string;
  phase: 'staging' | 'prepared';
  writes: Array<{
    path: string;
    stagedPath: string;
    sha256: string;
  }>;
};

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw filesystemError(path, error);
  }
}

function isMissing(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT');
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function filesystemError(path: string, error: unknown): GddError {
  if (error instanceof GddError) return error;
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return new GddError(`Unable to access ${path}.`, 'filesystem_error', {
    path,
    ...(typeof code === 'string' ? { code } : {})
  });
}

async function assertSafePath(root: string, relativePath: string): Promise<string> {
  if (!isSafeRelativePath(relativePath))
    throw new GddError(`Unsafe output path: ${relativePath}`, 'unsafe_path');
  const target = resolve(root, relativePath);
  if (!isInside(root, target))
    throw new GddError(`Unsafe output path: ${relativePath}`, 'unsafe_path');
  let cursor = root;
  for (const part of relativePath.split('/')) {
    cursor = resolve(cursor, part);
    if (await exists(cursor)) {
      const info = await lstat(cursor);
      if (info.isSymbolicLink())
        throw new GddError(`Refusing symbolic-link path: ${relativePath}`, 'unsafe_path');
    }
  }
  return target;
}

function isSafeRelativePath(value: string): boolean {
  return (
    Boolean(value) &&
    !isAbsolute(value) &&
    !value.includes('\\') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
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

async function writeTextAtomically(
  root: string,
  relativePath: string,
  content: string
): Promise<void> {
  const path = await assertSafePath(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await assertSafePath(root, relativePath);
  const temporaryRelativePath = `${relativePath}.${randomUUID()}.tmp`;
  const temporaryPath = await assertSafePath(root, temporaryRelativePath);
  try {
    await writeFile(temporaryPath, content, 'utf8');
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

async function writeJsonAtomically(
  root: string,
  relativePath: string,
  value: unknown
): Promise<void> {
  await writeTextAtomically(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function operationLeasePath(): string {
  return `${operationLockPath}/lease.json`;
}

function operationStagingDirectory(operationId: string): string {
  return `${managedStagingPath}/${operationId}`;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function parseOperationLease(value: unknown): OperationLease | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const lease = value as Record<string, unknown>;
  const operationId = lease.operationId;
  const command = lease.command;
  const startedAt = lease.startedAt;
  const pid = lease.pid;
  if (
    lease.schemaVersion !== 1 ||
    typeof operationId !== 'string' ||
    (command !== 'archive' && command !== 'init' && command !== 'update') ||
    !isIsoUtc(startedAt) ||
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid < 1
  ) {
    return undefined;
  }
  return {
    operationId,
    command,
    startedAt,
    pid
  };
}

async function readOperationLease(root: string): Promise<OperationLease | undefined> {
  const lockPath = await assertSafePath(root, operationLockPath);
  if (!(await exists(lockPath))) return undefined;
  const info = await lstat(lockPath);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new GddError('GDD operation lock is unsafe or malformed.', 'operation_in_progress');
  }
  const text = await readOptionalFile(root, operationLeasePath());
  if (text === undefined) {
    throw new GddError('GDD operation lock is incomplete.', 'operation_in_progress');
  }
  try {
    const lease = parseOperationLease(JSON.parse(text));
    if (!lease) throw new Error();
    return lease;
  } catch {
    throw new GddError('GDD operation lock is malformed.', 'operation_in_progress');
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, 'ESRCH');
  }
}

async function acquireOperation(root: string, command: OperationName): Promise<OperationLease> {
  const lockPath = await assertSafePath(root, operationLockPath);
  await mkdir(dirname(lockPath), { recursive: true });
  await assertSafePath(root, operationLockPath);
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) throw filesystemError(lockPath, error);
    const existing = await readOperationLease(root);
    if (!existing || isProcessAlive(existing.pid)) {
      throw new GddError(
        'A GDD operation is already in progress for this project.',
        'operation_in_progress'
      );
    }
    const stalePath = `${lockPath}.${randomUUID()}.stale`;
    await rename(lockPath, stalePath);
    try {
      await mkdir(lockPath);
    } catch (replacementError) {
      throw filesystemError(lockPath, replacementError);
    }
    await removeSafeDirectoryTree(root, stalePath);
  }
  const lease: OperationLease = {
    operationId: randomUUID(),
    command,
    startedAt: now(),
    pid: process.pid
  };
  try {
    await writeJsonAtomically(root, operationLeasePath(), { schemaVersion: 1, ...lease });
  } catch (error) {
    await removeSafeDirectoryTree(root, lockPath);
    throw error;
  }
  return lease;
}

async function releaseOperation(root: string, operationId: string): Promise<void> {
  const lease = await readOperationLease(root);
  if (!lease || lease.operationId !== operationId) {
    throw new GddError(
      'GDD operation lock ownership changed unexpectedly.',
      'operation_in_progress'
    );
  }
  const lockPath = await assertSafePath(root, operationLockPath);
  await removeSafeDirectoryTree(root, lockPath);
}

async function assertOperationReadable(root: string, operationId?: string): Promise<void> {
  const lease = await readOperationLease(root);
  if (lease && lease.operationId !== operationId) {
    throw new GddError(
      'A GDD operation is already in progress for this project.',
      'operation_in_progress'
    );
  }
}

function parseManagedWriteJournal(value: unknown): ManagedWriteJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GddError('Managed-write recovery journal is malformed.', 'operation_in_progress');
  }
  const journal = value as Record<string, unknown>;
  const operationId = journal.operationId;
  const command = journal.command;
  const createdAt = journal.createdAt;
  const phase = journal.phase;
  const rawWrites = journal.writes;
  if (
    journal.schemaVersion !== 1 ||
    typeof operationId !== 'string' ||
    (command !== 'init' && command !== 'update') ||
    !isIsoUtc(createdAt) ||
    (phase !== 'staging' && phase !== 'prepared') ||
    !Array.isArray(rawWrites)
  ) {
    throw new GddError('Managed-write recovery journal is malformed.', 'operation_in_progress');
  }
  const writes = rawWrites.map((write) => {
    if (!write || typeof write !== 'object' || Array.isArray(write)) {
      throw new GddError('Managed-write recovery journal is malformed.', 'operation_in_progress');
    }
    const entry = write as Record<string, unknown>;
    if (
      typeof entry.path !== 'string' ||
      !isSafeRelativePath(entry.path) ||
      typeof entry.stagedPath !== 'string' ||
      !entry.stagedPath.startsWith(`${operationStagingDirectory(operationId)}/`) ||
      !isSafeRelativePath(entry.stagedPath) ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new GddError('Managed-write recovery journal is malformed.', 'operation_in_progress');
    }
    return { path: entry.path, stagedPath: entry.stagedPath, sha256: entry.sha256 };
  });
  if (new Set(writes.map((write) => write.path)).size !== writes.length) {
    throw new GddError('Managed-write recovery journal is malformed.', 'operation_in_progress');
  }
  return {
    schemaVersion: 1,
    operationId,
    command,
    createdAt,
    phase,
    writes
  };
}

async function readManagedWriteJournal(root: string): Promise<ManagedWriteJournal | undefined> {
  const text = await readOptionalFile(root, managedJournalPath);
  if (text === undefined) return undefined;
  try {
    return parseManagedWriteJournal(JSON.parse(text));
  } catch (error) {
    if (error instanceof GddError) throw error;
    throw new GddError('Managed-write recovery journal is malformed.', 'operation_in_progress');
  }
}

async function removeManagedStagingDirectory(root: string, operationId: string): Promise<void> {
  const path = await assertSafePath(root, operationStagingDirectory(operationId));
  if (await exists(path)) await removeSafeDirectoryTree(root, path);
  const rootPath = await assertSafePath(root, managedStagingPath);
  if (await exists(rootPath)) {
    const info = await lstat(rootPath);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new GddError(
        'Managed-write staging directory is unsafe or malformed.',
        'operation_in_progress'
      );
    }
    if ((await readdir(rootPath)).length === 0) await rmdir(rootPath);
  }
}

async function assertManagedStagingLayout(
  root: string,
  journal: ManagedWriteJournal
): Promise<void> {
  const rootPath = await assertSafePath(root, managedStagingPath);
  if (!(await exists(rootPath))) {
    if (journal.phase === 'prepared') {
      throw new GddError(
        'Managed-write recovery cannot locate staged content.',
        'operation_in_progress'
      );
    }
    return;
  }
  const rootInfo = await lstat(rootPath);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new GddError(
      'Managed-write staging directory is unsafe or malformed.',
      'operation_in_progress'
    );
  }
  const rootEntries = await readdir(rootPath, { withFileTypes: true });
  if (rootEntries.some((entry) => entry.name !== journal.operationId)) {
    throw new GddError(
      'Managed-write staging contains an untracked operation.',
      'operation_in_progress'
    );
  }
  const operationPath = await assertSafePath(root, operationStagingDirectory(journal.operationId));
  if (!(await exists(operationPath))) {
    if (journal.phase === 'prepared') {
      throw new GddError(
        'Managed-write recovery cannot locate staged content.',
        'operation_in_progress'
      );
    }
    return;
  }
  const operationInfo = await lstat(operationPath);
  if (operationInfo.isSymbolicLink() || !operationInfo.isDirectory()) {
    throw new GddError(
      'Managed-write staging directory is unsafe or malformed.',
      'operation_in_progress'
    );
  }
  if (journal.phase === 'staging') return;
  const expected = new Set(journal.writes.map((write) => basename(write.stagedPath)));
  const stagedEntries = await readdir(operationPath, { withFileTypes: true });
  if (
    stagedEntries.length !== expected.size ||
    stagedEntries.some((entry) => !entry.isFile() || !expected.has(entry.name))
  ) {
    throw new GddError(
      'Managed-write recovery cannot verify staged content.',
      'operation_in_progress'
    );
  }
}

async function recoverManagedWrites(root: string): Promise<void> {
  const journal = await readManagedWriteJournal(root);
  if (!journal) {
    const rootPath = await assertSafePath(root, managedStagingPath);
    if (!(await exists(rootPath))) return;
    const info = await lstat(rootPath);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new GddError(
        'Managed-write staging directory is unsafe or malformed.',
        'operation_in_progress'
      );
    }
    if ((await readdir(rootPath)).length) {
      throw new GddError('Managed-write recovery journal is missing.', 'operation_in_progress');
    }
    await rmdir(rootPath);
    return;
  }
  await assertManagedStagingLayout(root, journal);
  if (journal.phase === 'staging') {
    await removeManagedStagingDirectory(root, journal.operationId);
    await removeRegularFile(root, managedJournalPath);
    return;
  }
  for (const write of journal.writes) {
    const content = await readOptionalFile(root, write.stagedPath);
    if (content === undefined || hashContent(content) !== write.sha256) {
      throw new GddError(
        'Managed-write recovery cannot verify staged content.',
        'operation_in_progress'
      );
    }
    await writeTextAtomically(root, write.path, content);
  }
  await removeManagedStagingDirectory(root, journal.operationId);
  await removeRegularFile(root, managedJournalPath);
}

async function commitManagedWrites(
  root: string,
  lease: OperationLease,
  command: 'init' | 'update',
  writes: ManagedWrite[]
): Promise<void> {
  if (!writes.length) return;
  const stagedWrites = writes.map((write, index) => ({
    path: write.path,
    stagedPath: `${operationStagingDirectory(lease.operationId)}/${index}.content`,
    sha256: hashContent(write.content),
    content: write.content
  }));
  const journal: ManagedWriteJournal = {
    schemaVersion: 1,
    operationId: lease.operationId,
    command,
    createdAt: now(),
    phase: 'staging',
    writes: stagedWrites.map(({ path, stagedPath, sha256 }) => ({ path, stagedPath, sha256 }))
  };
  await writeJsonAtomically(root, managedJournalPath, journal);
  for (const stagedWrite of stagedWrites) {
    await writeTextAtomically(root, stagedWrite.stagedPath, stagedWrite.content);
  }
  await writeJsonAtomically(root, managedJournalPath, { ...journal, phase: 'prepared' });
  await recoverManagedWrites(root);
}

async function withOperation<T>(
  root: string,
  command: OperationName,
  operation: (lease: OperationLease) => Promise<T>
): Promise<T> {
  const lease = await acquireOperation(root, command);
  try {
    await recoverManagedWrites(root);
    return await operation(lease);
  } finally {
    await releaseOperation(root, lease.operationId);
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
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw filesystemError(path, error);
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

async function eligibleArchiveRecord(
  root: string,
  slug: string,
  operationId: string
): Promise<ChangeRecord> {
  const changePath = await assertSafePath(root, archiveChangePath(slug));
  if (!(await exists(changePath))) throw new GddError(`GDD change not found: ${slug}`, 'not_found');
  await assertSafeDirectoryTree(root, changePath);
  const result = await status(root, undefined, operationId);
  const record = result.records.find(
    (candidate) => candidate.path === `${archiveChangePath(slug)}/change.md`
  );
  if (!record) throw new GddError(`GDD change not found: ${slug}`, 'not_found');
  if (record.state !== 'verified')
    throw new GddError(`Only verified changes can be archived: ${slug}`, 'archive_incomplete');
  const issues = result.invalid.filter((issue) => issueBelongsToChange(issue.path, slug));
  if (issues.length || record.tasks.open || record.tasks.invalid) {
    throw new GddError(
      `GDD change must be complete and valid before archiving: ${slug}`,
      'archive_incomplete'
    );
  }
  return record;
}

export async function archive(
  rootInput: string,
  slug: string,
  confirmed: boolean
): Promise<ArchiveSummary> {
  if (!confirmed)
    throw new GddError(
      'Archiving requires explicit confirmation.',
      'archive_confirmation_required'
    );
  if (!isArchiveSlug(slug))
    throw new GddError('Archive slug must be a kebab-case change ID.', 'invalid_argument');
  const root = normalizeRoot(rootInput);
  return withOperation(root, 'archive', async (lease) => {
    await recoverArchive(root);
    const record = await eligibleArchiveRecord(root, slug, lease.operationId);
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
      tasks: record.tasks.total,
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
  });
}

export async function readManifest(root: string): Promise<Manifest | undefined> {
  const path = await assertSafePath(root, manifestPath);
  const text = await readText(path);
  if (text === undefined) return undefined;
  if (!text.trim()) throw new GddError(`Invalid GDD manifest: ${manifestPath}`, 'invalid_manifest');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new GddError(`Invalid GDD manifest: ${manifestPath}`, 'invalid_manifest');
  }
  const manifest = parseManifest(value);
  for (const managedPath of manifest.managedPaths) await assertSafePath(root, managedPath);
  return manifest;
}

function parseManifest(value: unknown): Manifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GddError(`Invalid GDD manifest: ${manifestPath}`, 'invalid_manifest');
  }
  const manifest = value as Record<string, unknown>;
  const expectedFields = new Set([
    'schemaVersion',
    'generatedBy',
    'generatorVersion',
    'hosts',
    'managedPaths',
    'createdAt',
    'updatedAt'
  ]);
  if (Object.keys(manifest).some((key) => !expectedFields.has(key))) {
    throw new GddError(`Invalid GDD manifest: ${manifestPath}`, 'invalid_manifest');
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.generatedBy !== 'gdd' ||
    !isVersion(manifest.generatorVersion) ||
    !Array.isArray(manifest.hosts) ||
    !Array.isArray(manifest.managedPaths) ||
    !isIsoUtc(manifest.createdAt) ||
    !isIsoUtc(manifest.updatedAt)
  ) {
    throw new GddError(`Invalid GDD manifest: ${manifestPath}`, 'invalid_manifest');
  }
  const hosts = manifest.hosts;
  const managedPaths = manifest.managedPaths;
  if (
    !hosts.length ||
    hosts.some((host) => host !== 'agents' && host !== 'github') ||
    new Set(hosts).size !== hosts.length ||
    managedPaths.some((path) => typeof path !== 'string' || !isSafeRelativePath(path)) ||
    new Set(managedPaths).size !== managedPaths.length
  ) {
    throw new GddError(`Invalid GDD manifest: ${manifestPath}`, 'invalid_manifest');
  }
  return {
    schemaVersion: 1,
    generatedBy: 'gdd',
    generatorVersion: manifest.generatorVersion,
    hosts: [...hosts],
    managedPaths: [...managedPaths],
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt
  };
}

function isVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
  );
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

async function planManagedWrites(
  root: string,
  files: Record<string, string>,
  force: boolean
): Promise<{ actions: Action[]; writes: ManagedWrite[] }> {
  const actions: Action[] = [];
  const writes: ManagedWrite[] = [];
  for (const [relativePath, content] of Object.entries(files)) {
    const path = await assertSafePath(root, relativePath);
    const previous = await readText(path);
    if (previous === undefined) {
      writes.push({ path: relativePath, content });
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
    writes.push({ path: relativePath, content });
    actions.push({ path: relativePath, status: 'updated' });
  }
  return { actions, writes };
}

export async function init(
  rootInput: string,
  hosts: Host[],
  force: boolean,
  version: string
): Promise<Action[]> {
  const root = normalizeRoot(rootInput);
  return withOperation(root, 'init', async (lease) => {
    const prior = await readManifest(root);
    const selected = [...new Set([...(prior?.hosts ?? []), ...hosts])].sort() as Host[];
    if (!selected.length)
      throw new GddError('Select at least one supported host.', 'invalid_argument');
    const files = filesFor(selected, version);
    const plan = await planManagedWrites(root, files, force);
    if (plan.actions.some((action) => action.status === 'refused')) return plan.actions;
    const timestamp = now();
    const manifest: Manifest = {
      schemaVersion: 1,
      generatedBy: 'gdd',
      generatorVersion: version,
      hosts: selected,
      managedPaths: managedPathsFor(prior?.managedPaths ?? [], files),
      createdAt: prior?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    await commitManagedWrites(root, lease, 'init', [
      ...plan.writes,
      { path: manifestPath, content: `${JSON.stringify(manifest, null, 2)}\n` }
    ]);
    return plan.actions;
  });
}

export async function update(rootInput: string, version: string): Promise<Action[]> {
  const root = normalizeRoot(rootInput);
  return withOperation(root, 'update', async (lease) => {
    const manifest = await readManifest(root);
    if (!manifest)
      throw new GddError('GDD is not initialized. Run gdd init first.', 'not_initialized');
    const files = filesFor(manifest.hosts, version);
    const plan = await planManagedWrites(root, files, true);
    if (plan.actions.some((action) => action.status === 'refused')) return plan.actions;
    const updatedManifest: Manifest = {
      ...manifest,
      generatorVersion: version,
      managedPaths: managedPathsFor(manifest.managedPaths, files),
      updatedAt: now()
    };
    await commitManagedWrites(root, lease, 'update', [
      ...plan.writes,
      { path: manifestPath, content: `${JSON.stringify(updatedManifest, null, 2)}\n` }
    ]);
    return plan.actions;
  });
}

async function findMarkdownFiles(directory: string, missingIsEmpty = false): Promise<string[]> {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (isMissing(error)) {
      if (missingIsEmpty) return [];
      throw new GddError(
        'GDD directory is missing. Run gdd init --force to repair the installation.',
        'not_initialized'
      );
    }
    throw filesystemError(directory, error);
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
    path: relative(root, path),
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
    path: relative(root, path),
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

export async function status(
  rootInput: string,
  state?: ChangeState,
  operationId?: string
): Promise<StatusResult> {
  const root = normalizeRoot(rootInput);
  await assertOperationReadable(root, operationId);
  const manifest = await readManifest(root);
  if (!manifest)
    throw new GddError('Invalid or missing GDD manifest. Run gdd init first.', 'not_initialized');
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
        invalid.push({ path: relative(root, taskPath), error: errors.join('; ') });
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
