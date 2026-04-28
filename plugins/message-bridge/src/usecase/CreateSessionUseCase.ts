import type { CreateSessionPayload, CreateSessionResultData } from '../contracts/downstream-messages.js';
import type { SessionCreationPort } from '../port/SessionCreationPort.js';
import type { ActionResult } from '../types/action-runtime.js';
import { isImGroupTitle } from '../session/isImGroupTitle.js';
import type {
  ResolveCreateSessionDirectoryUseCase,
  ResolvedCreateSessionDirectory,
} from './ResolveCreateSessionDirectoryUseCase.js';

export interface CreateSessionUseCaseInput {
  payload: CreateSessionPayload;
  effectiveDirectory?: string;
  mappingConfigured?: boolean;
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
      assistantId: input.payload.assistantId,
      effectiveDirectory: input.effectiveDirectory,
      mappingConfigured: input.mappingConfigured,
    });

    return {
      ...resolvedDirectory,
      resolvedDirectory: resolvedDirectory.directory,
      resolvedDirectorySource: resolvedDirectory.source,
    };
  }

  /** IM 群会话默认收紧高风险工具权限；非 IM 群保持不传 permission 字段。 */
  resolvePermission(input: CreateSessionUseCaseInput): Array<Record<string, unknown>> | undefined {
    if (!isImGroupTitle(input.payload.title)) {
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
      title: input.payload.title,
      directory: prepared.resolvedDirectory,
      ...(permission ? { permission } : {}),
    });
  }
}
