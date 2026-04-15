import type { CreateSessionPayload, CreateSessionResultData } from '../contracts/downstream-messages.js';
import type { SessionCreationPort } from '../port/SessionCreationPort.js';
import type { ActionResult } from '../types/action-runtime.js';
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

  resolvePermission(input: CreateSessionUseCaseInput): Array<Record<string, unknown>> | undefined {
    const isIMGroup = input.payload.title?.match(/^im-group/);
    if (!isIMGroup) {
      return undefined;
    }

    return [
      { "permission": "bash", "pattern": "*", "action": "deny" },
      { "permission": "read", "pattern": "*", "action": "deny" },
      { "permission": "glob", "pattern": "*", "action": "deny" },
      { "permission": "grep", "pattern": "*", "action": "deny" },
      { "permission": "edit", "pattern": "*", "action": "deny" },
      { "permission": "write", "pattern": "*", "action": "deny" },
      { "permission": "task", "pattern": "*", "action": "deny" },
      { "permission": "webfetch", "pattern": "*", "action": "deny" },
      { "permission": "myAgentWebFetch", "pattern": "*", "action": "deny" },
      { "permission": "meeting*", "pattern": "*", "action": "deny" },
      { "permission": "knowledge*", "pattern": "*", "action": "deny" },
      { "permission": "playwright*", "pattern": "*", "action": "deny" },
    ];
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
