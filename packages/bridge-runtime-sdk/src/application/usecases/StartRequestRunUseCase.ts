import { randomUUID } from 'node:crypto';

import type { ProviderCommandHandlers } from '../../adapters/provider/provider-api-adapter.ts';
import { RuntimeContractError } from '../../domain/errors.ts';
import type { ProviderRunMessageInput } from '../../domain/provider.ts';
import type { RuntimeCommand } from '../../domain/runtime-command.ts';
import type { RequestRunCoordinator } from '../coordinators/index.ts';
import type { StartRequestRunUseCase as StartRequestRunUseCasePort } from '../ports/runtime-usecase.ts';
import type { SessionRuntimeRegistry } from '../ports/session-runtime-registry.ts';
import type { ResolvedRequestRunPolicy } from '../runtime-assembly/request-run-policy.ts';
import type { RuntimeObservation } from '../runtime-observation/index.ts';

type StartRequestRunCommand = Extract<RuntimeCommand, { kind: 'start_request_run' }>;

export class StartRequestRunUseCase implements StartRequestRunUseCasePort {
  private readonly handlers: ProviderCommandHandlers;
  private readonly sessionRegistry: SessionRuntimeRegistry;
  private readonly coordinator: RequestRunCoordinator;
  private readonly observation: RuntimeObservation;
  private readonly requestRunPolicy: ResolvedRequestRunPolicy;

  constructor(
    handlers: ProviderCommandHandlers,
    sessionRegistry: SessionRuntimeRegistry,
    coordinator: RequestRunCoordinator,
    observation: RuntimeObservation,
    requestRunPolicy: ResolvedRequestRunPolicy,
  ) {
    this.handlers = handlers;
    this.sessionRegistry = sessionRegistry;
    this.coordinator = coordinator;
    this.observation = observation;
    this.requestRunPolicy = requestRunPolicy;
  }

  async execute(command: StartRequestRunCommand): Promise<void> {
    const runId = randomUUID();
    const toolSessionId = command.source.payload.toolSessionId;
    const context = {
      toolSessionId,
      welinkSessionId: command.source.welinkSessionId,
      runId,
    };
    const activeRunState = this.sessionRegistry.getRequestRunState(toolSessionId);
    const activeRunIds = [...activeRunState.activeRunIds];
    this.observation.usecaseStarted('start_request_run', command.traceId, {
      ...context,
      activeRunChatPolicy: this.requestRunPolicy.activeRunChatPolicy,
      activeRunIds,
    });
    if (activeRunState.activeRunIds.length > 0 && this.requestRunPolicy.activeRunChatPolicy === 'reject') {
      const error = new RuntimeContractError(
        'run_already_active',
        `toolSessionId already has an active request run: ${toolSessionId}`,
        { toolSessionId, runId },
      );
      this.observation.usecaseConflict('start_request_run', command.traceId, error, error.code, context);
      throw error;
    }
    this.sessionRegistry.registerRequestRun(toolSessionId, runId);

    const sessionRecord = this.sessionRegistry.ensure({
      toolSessionId,
      welinkSessionId: command.source.welinkSessionId,
    });

    try {
      const run = await this.handlers.startRequestRun(createProviderRunMessageInput(command, runId, toolSessionId));
      await this.coordinator.executeRun({
        toolSessionId,
        welinkSessionId: command.source.welinkSessionId ?? sessionRecord.welinkSessionId,
        runId,
        run,
      });
      this.observation.usecaseSucceeded('start_request_run', command.traceId, {
        toolSessionId,
        welinkSessionId: command.source.welinkSessionId ?? sessionRecord.welinkSessionId,
        runId,
      });
    } catch (error) {
      this.observation.usecaseFailed(
        'start_request_run',
        command.traceId,
        error,
        error instanceof RuntimeContractError ? error.code : undefined,
        {
          toolSessionId,
          welinkSessionId: command.source.welinkSessionId ?? sessionRecord.welinkSessionId,
          runId,
        },
      );
      throw error;
    } finally {
      this.sessionRegistry.releaseRequestRun(toolSessionId, runId);
    }
  }
}

function createProviderRunMessageInput(
  command: StartRequestRunCommand,
  runId: string,
  toolSessionId: string,
): ProviderRunMessageInput {
  const providerContext = {
    ...(command.source.payload.assistantAccount ? { assistantAccount: command.source.payload.assistantAccount } : {}),
    ...(command.source.payload.sendUserAccount ? { sendUserAccount: command.source.payload.sendUserAccount } : {}),
    ...(command.source.suppressReply !== undefined ? { suppressReply: command.source.suppressReply } : {}),
  };
  return {
    traceId: command.traceId,
    runId,
    toolSessionId,
    text: command.source.payload.text,
    ...(command.source.payload.assistantId ? { assistantId: command.source.payload.assistantId } : {}),
    extParameters: command.source.payload.extParameters,
    ...(Object.keys(providerContext).length > 0 ? { context: providerContext } : {}),
  };
}
