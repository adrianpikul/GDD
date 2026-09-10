export const AUTOMATION_CONTRACT_VERSION = 1;

export type GddErrorCode =
  | 'archive_confirmation_required'
  | 'archive_incomplete'
  | 'filesystem_error'
  | 'internal_error'
  | 'invalid_argument'
  | 'invalid_manifest'
  | 'not_initialized'
  | 'not_found'
  | 'operation_in_progress'
  | 'unmanaged_collision'
  | 'unsafe_path';

export class GddError extends Error {
  constructor(
    message: string,
    public readonly code: GddErrorCode = 'internal_error',
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'GddError';
  }
}

export type CommandName = 'archive' | 'init' | 'status' | 'update';

export type CommandSuccess<T> = {
  contractVersion: typeof AUTOMATION_CONTRACT_VERSION;
  gddVersion: string;
  command: CommandName;
  ok: true;
  result: T;
};

export type CommandFailure = {
  contractVersion: typeof AUTOMATION_CONTRACT_VERSION;
  gddVersion: string;
  command: CommandName;
  ok: false;
  error: {
    code: GddErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
};

export function commandSuccess<T>(
  command: CommandName,
  gddVersion: string,
  result: T
): CommandSuccess<T> {
  return {
    contractVersion: AUTOMATION_CONTRACT_VERSION,
    gddVersion,
    command,
    ok: true,
    result
  };
}

export function commandFailure(
  command: CommandName,
  gddVersion: string,
  error: unknown
): CommandFailure {
  const gddError = toGddError(error);
  return {
    contractVersion: AUTOMATION_CONTRACT_VERSION,
    gddVersion,
    command,
    ok: false,
    error: {
      code: gddError.code,
      message: gddError.message,
      ...(gddError.details ? { details: gddError.details } : {})
    }
  };
}

export function toGddError(error: unknown): GddError {
  if (error instanceof GddError) return error;
  if (isNodeError(error)) {
    return new GddError('Filesystem operation failed.', 'filesystem_error', {
      code: error.code
    });
  }
  return new GddError('Unexpected GDD failure.', 'internal_error');
}

function isNodeError(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}
