import type { CreateSessionResultData } from '../contracts/downstream-messages.js';
import type { SessionCreationPort } from '../port/SessionCreationPort.js';
import type { ActionResult } from '../types/action-runtime.js';
import type {
  ResolveCreateSessionDirectoryUseCase,
  ResolvedCreateSessionDirectory,
} from './ResolveCreateSessionDirectoryUseCase.js';
import type { CreateSessionRequest } from './CreateSessionRequestNormalizer.js';

/** 统一建会话用例输入：只保留业务语义与环境注入，不再泄露入口差异。 */
export interface CreateSessionUseCaseInput extends CreateSessionRequest {
  effectiveDirectory?: string;
  directoryMappingEnabled: boolean;
}

export interface PreparedCreateSession extends ResolvedCreateSessionDirectory {
  resolvedDirectory?: string;
  resolvedDirectorySource: ResolvedCreateSessionDirectory['source'];
}

const IM_GROUP_DENY_PERMISSIONS = [
  'bash',
  'read',
  'glob',
  'grep',
  'edit',
  'write',
  'task',
  'webfetch',
  'myAgentWebFetch',
  'meeting*',
  'knowledge*',
  'playwright*',
] as const;

export class CreateSessionUseCase {
  constructor(
    private readonly resolveCreateSessionDirectoryUseCase: ResolveCreateSessionDirectoryUseCase,
    private readonly sessionCreationPort: SessionCreationPort,
  ) {}

  async resolveCreateSession(input: CreateSessionUseCaseInput): Promise<PreparedCreateSession> {
    const resolvedDirectory = await this.resolveCreateSessionDirectoryUseCase.execute({
      assistantId: input.assistantId,
      effectiveDirectory: input.effectiveDirectory,
      directoryMappingEnabled: input.directoryMappingEnabled,
    });

    return {
      ...resolvedDirectory,
      resolvedDirectory: resolvedDirectory.directory,
      resolvedDirectorySource: resolvedDirectory.source,
    };
  }

  /** IM 群会话默认收紧高风险工具权限；非 IM 群保持不传 permission 字段。 */
  resolvePermission(input: CreateSessionUseCaseInput): Array<Record<string, unknown>> | undefined {
    if (!input.isGroupChat) {
      return undefined;
    }

    return IM_GROUP_DENY_PERMISSIONS.map((permission) => ({
      permission,
      pattern: '*',
      action: 'deny',
    }));
  }

  async execute(
    input: CreateSessionUseCaseInput,
    preparedCreateSession?: PreparedCreateSession,
  ): Promise<ActionResult<CreateSessionResultData>> {
    const prepared = preparedCreateSession ?? await this.resolveCreateSession(input);
    const permission = this.resolvePermission(input);

    return this.sessionCreationPort.createSession({
      title: input.title,
      directory: prepared.resolvedDirectory,
      ...(permission ? { permission } : {}),
    });
  }
}
