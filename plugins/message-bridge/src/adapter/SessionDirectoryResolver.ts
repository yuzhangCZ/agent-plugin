import type { BridgeLogger } from '../types/logger.js';
import type { ToolErrorEvidence } from '../utils/error.js';
import type { SessionLookupView } from './SessionLookupResolver.js';

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export type SessionDirectoryResolutionResult =
  | { success: true; directory: string }
  | {
    success: false;
    reason: 'missing_directory';
    errorEvidence?: ToolErrorEvidence;
  };

/** session 目录解析输入。 */
export interface ResolveSessionDirectoryInput {
  sessionId: string;
  session: SessionLookupView;
  logger?: BridgeLogger;
  logFields?: Record<string, unknown>;
}

/**
 * session 目录解析器。
 * @remarks 只消费预检后的最小 session 视图，不再承担 session.get 和 not_found 语义。
 */
export class SessionDirectoryResolver {
  resolve(input: ResolveSessionDirectoryInput): SessionDirectoryResolutionResult {
    const directory = pickString(input.session.directory);
    if (!directory) {
      input.logger?.warn('session_directory.session_view.directory_missing', {
        toolSessionId: input.sessionId,
        ...(input.logFields ?? {}),
      });
      return {
        success: false,
        reason: 'missing_directory',
        errorEvidence: { sourceOperation: 'session.get' },
      };
    }

    input.logger?.debug('session_directory.session_view.directory_resolved', {
      toolSessionId: input.sessionId,
      directory,
      ...(input.logFields ?? {}),
    });
    return {
      success: true,
      directory,
    };
  }
}
