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

  async execute(
    input: CreateSessionUseCaseInput,
    preparedCreateSession?: PreparedCreateSession,
  ): Promise<ActionResult<CreateSessionResultData>> {
    const prepared = preparedCreateSession ?? await this.resolveCreateSession(input);

    return this.sessionCreationPort.createSession({
      title: input.payload.title,
      directory: prepared.resolvedDirectory,
    });
  }
}
