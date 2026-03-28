import type { CreateSessionPayload, CreateSessionResultData } from '../contracts/downstream-messages.js';
import type { SessionGatewayPort } from '../port/SessionGatewayPort.js';
import type { ActionResult } from '../types/action-runtime.js';
import type { ResolveCreateSessionDirectoryUseCase } from './ResolveCreateSessionDirectoryUseCase.js';

export interface CreateSessionUseCaseInput {
  payload: CreateSessionPayload;
  effectiveDirectory?: string;
  mappingConfigured?: boolean;
}

export class CreateSessionUseCase {
  constructor(
    private readonly resolveCreateSessionDirectoryUseCase: ResolveCreateSessionDirectoryUseCase,
    private readonly sessionGatewayPort: SessionGatewayPort,
  ) {}

  async execute(input: CreateSessionUseCaseInput): Promise<ActionResult<CreateSessionResultData>> {
    const resolvedDirectory = await this.resolveCreateSessionDirectoryUseCase.execute({
      assistantId: input.payload.assistantId,
      effectiveDirectory: input.effectiveDirectory,
      mappingConfigured: input.mappingConfigured,
    });

    return this.sessionGatewayPort.createSession({
      title: input.payload.title,
      directory: resolvedDirectory.directory,
    });
  }
}
