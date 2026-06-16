import { getErrorMessage } from '../utils/error.js';

export interface OpencodeHealthResult {
  healthy: boolean;
  version?: string;
}

export interface HostClientLike {
  global?: {
    health?: (options?: Record<string, unknown>) => Promise<OpencodeHealthResult> | OpencodeHealthResult;
  };
  app?: {
    log?: (options?: {
      body?: {
        service: string;
        level: 'debug' | 'info' | 'warn' | 'error';
        message: string;
        extra?: Record<string, unknown>;
      };
    }) => Promise<unknown> | unknown;
  };
}

export interface BridgeSessionClient {
  create(options?: {
    directory?: string;
    parentID?: string;
    title?: string;
    permission?: Array<Record<string, unknown>>;
  }): Promise<unknown>;
  get(options: { sessionID: string; directory?: string }): Promise<unknown>;
  list(options?: {
    directory?: string;
    roots?: boolean;
    start?: number;
  }): Promise<unknown>;
  abort(options: { sessionID: string; directory?: string }): Promise<unknown>;
  delete(options: { sessionID: string; directory?: string }): Promise<unknown>;
  prompt(options: {
    sessionID: string;
    directory?: string;
    model?: {
      providerID: string;
      modelID: string;
    };
    agent?: string;
    parts?: Array<{ type: 'text'; text: string }>;
  }): Promise<unknown>;
}

export interface BridgeConfigClient {
  providers(options?: { directory?: string }): Promise<unknown>;
}

export interface BridgePermissionClient {
  reply(options: {
    permissionId: string;
    response: 'once' | 'always' | 'reject';
    directory?: string;
  }): Promise<unknown>;
}

export interface BridgeQuestionClient {
  reply(options: {
    questionId: string;
    answers: string[][];
  }): Promise<unknown>;
}

export interface BridgeSdkClient {
  session: BridgeSessionClient;
  config: BridgeConfigClient;
  permission: BridgePermissionClient;
  question: BridgeQuestionClient;
}

export interface HostSdkClient {
  session: {
    create: (options?: Record<string, unknown>) => Promise<unknown>;
    get: (options: Record<string, unknown>) => Promise<unknown>;
    list: (options?: Record<string, unknown>) => Promise<unknown>;
    prompt: (options: Record<string, unknown>) => Promise<unknown>;
    abort: (options: Record<string, unknown>) => Promise<unknown>;
    delete: (options: Record<string, unknown>) => Promise<unknown>;
  };
  config: {
    providers: (options?: Record<string, unknown>) => Promise<unknown>;
  };
  _client: {
    get: (options: Record<string, unknown>) => Promise<unknown>;
    post: (options: Record<string, unknown>) => Promise<unknown>;
  };
}

export async function safeExecute<T>(
  promise: Promise<T>,
  errorMapper?: (error: unknown) => string,
): Promise<{ success: true; data: T } | { success: false; error: string }> {
  try {
    const data = await promise;
    return { success: true, data };
  } catch (error) {
    const errorMessage = errorMapper
      ? errorMapper(error)
      : getErrorMessage(error);
    return { success: false, error: errorMessage };
  }
}

export function hasError(result: unknown): result is { error: unknown } {
  return result !== null && typeof result === 'object' && 'error' in result && (result as { error?: unknown }).error !== undefined;
}
