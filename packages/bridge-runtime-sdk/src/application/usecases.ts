import { randomUUID } from 'node:crypto';

import { RuntimeContractError } from '../domain/errors.ts';
import type { RuntimeCommand } from '../domain/runtime-command.ts';
import type {
  AbortExecutionUseCase as AbortExecutionUseCasePort,
  CloseSessionUseCase as CloseSessionUseCasePort,
  CreateSessionUseCase as CreateSessionUseCasePort,
  QueryStatusUseCase as QueryStatusUseCasePort,
  ReplyPermissionUseCase as ReplyPermissionUseCasePort,
  ReplyQuestionUseCase as ReplyQuestionUseCasePort,
  StartRequestRunUseCase as StartRequestRunUseCasePort,
} from './ports/runtime-usecase.ts';
import type { ProviderCommandHandlers } from '../adapters/provider/provider-api-adapter.ts';
import type {
  GatewayCommandResultProjector,
} from './projectors.ts';
import type { OutboundSink } from './ports/outbound-sink.ts';
import type { PendingInteractionRegistry } from './ports/pending-interaction-registry.ts';
import type { SessionRuntimeRegistry } from './ports/session-runtime-registry.ts';
import { InteractionCoordinator, RequestRunCoordinator } from './coordinators.ts';
import type { RuntimeObservation } from './runtime-observation.ts';

export class QueryStatusUseCase implements QueryStatusUseCasePort {
  private readonly handlers: ProviderCommandHandlers;
  private readonly sink: OutboundSink;
  private readonly projector: GatewayCommandResultProjector;
  private readonly observation: RuntimeObservation;

  constructor(
    handlers: ProviderCommandHandlers,
    sink: OutboundSink,
    projector: GatewayCommandResultProjector,
    observation: RuntimeObservation,
  ) {
    this.handlers = handlers;
    this.sink = sink;
    this.projector = projector;
    this.observation = observation;
  }

  async execute(command: Extract<RuntimeCommand, { kind: 'query_status' }>): Promise<void> {
    this.observation.usecaseStarted('query_status', command.traceId);
    try {
      const result = await this.handlers.queryStatus({ traceId: command.traceId });
      const uplink = this.projector.projectStatus({ online: result.online });
      this.observation.uplinkEmitted(uplink);
      await this.sink.send(uplink);
      this.observation.usecaseSucceeded('query_status', command.traceId);
    } catch (error) {
      this.observation.usecaseFailed('query_status', command.traceId, error);
      throw error;
    }
  }
}

export class CreateSessionUseCase implements CreateSessionUseCasePort {
  private readonly handlers: ProviderCommandHandlers;
  private readonly sessionRegistry: SessionRuntimeRegistry;
  private readonly sink: OutboundSink;
  private readonly projector: GatewayCommandResultProjector;
  private readonly observation: RuntimeObservation;

  constructor(
    handlers: ProviderCommandHandlers,
    sessionRegistry: SessionRuntimeRegistry,
    sink: OutboundSink,
    projector: GatewayCommandResultProjector,
    observation: RuntimeObservation,
  ) {
    this.handlers = handlers;
    this.sessionRegistry = sessionRegistry;
    this.sink = sink;
    this.projector = projector;
    this.observation = observation;
  }

  async execute(command: Extract<RuntimeCommand, { kind: 'create_session' }>): Promise<void> {
    const context = {
      welinkSessionId: command.source.welinkSessionId,
    };
    this.observation.usecaseStarted('create_session', command.traceId, context);
    try {
      const result = await this.handlers.createSession({
        traceId: command.traceId,
        title: command.source.payload.title,
        assistantId: command.source.payload.assistantId,
      });
      this.sessionRegistry.ensure({
        toolSessionId: result.toolSessionId,
        welinkSessionId: command.source.welinkSessionId,
      });
      const uplink = this.projector.projectSessionCreated({
        welinkSessionId: command.source.welinkSessionId,
        toolSessionId: result.toolSessionId,
      });
      this.observation.uplinkEmitted(uplink);
      await this.sink.send(uplink);
      this.observation.usecaseSucceeded('create_session', command.traceId, {
        ...context,
        toolSessionId: result.toolSessionId,
      });
    } catch (error) {
      this.observation.usecaseFailed('create_session', command.traceId, error, undefined, context);
      throw error;
    }
  }
}

export class StartRequestRunUseCase implements StartRequestRunUseCasePort {
  private readonly handlers: ProviderCommandHandlers;
  private readonly sessionRegistry: SessionRuntimeRegistry;
  private readonly coordinator: RequestRunCoordinator;
  private readonly observation: RuntimeObservation;

  constructor(
    handlers: ProviderCommandHandlers,
    sessionRegistry: SessionRuntimeRegistry,
    coordinator: RequestRunCoordinator,
    observation: RuntimeObservation,
  ) {
    this.handlers = handlers;
    this.sessionRegistry = sessionRegistry;
    this.coordinator = coordinator;
    this.observation = observation;
  }

  async execute(command: Extract<RuntimeCommand, { kind: 'start_request_run' }>): Promise<void> {
    const runId = randomUUID();
    const toolSessionId = command.source.payload.toolSessionId;
    const context = {
      toolSessionId,
      welinkSessionId: command.source.welinkSessionId,
      runId,
    };
    this.observation.usecaseStarted('start_request_run', command.traceId, context);
    const acquired = this.sessionRegistry.acquireActiveRun(toolSessionId, runId);
    if (!acquired.ok) {
      const error = new RuntimeContractError(
        'run_already_active',
        `toolSessionId already has an active request run: ${toolSessionId}`,
        { toolSessionId, runId },
      );
      this.observation.usecaseConflict('start_request_run', command.traceId, error, error.code, context);
      throw error;
    }

    const sessionRecord = this.sessionRegistry.ensure({
      toolSessionId,
      welinkSessionId: command.source.welinkSessionId,
    });

    try {
      const context = {
        ...(command.source.payload.assistantAccount ? { assistantAccount: command.source.payload.assistantAccount } : {}),
        ...(command.source.payload.sendUserAccount ? { sendUserAccount: command.source.payload.sendUserAccount } : {}),
        ...(command.source.payload.imGroupId ? { imGroupId: command.source.payload.imGroupId } : {}),
        ...(command.source.suppressReply !== undefined ? { suppressReply: command.source.suppressReply } : {}),
      };
      const run = await this.handlers.startRequestRun({
        traceId: command.traceId,
        runId,
        toolSessionId,
        text: command.source.payload.text,
        assistantId: command.source.payload.assistantId,
        ...(command.source.payload.extParameters !== undefined
          ? { extParameters: command.source.payload.extParameters }
          : {}),
        ...(Object.keys(context).length > 0 ? { context } : {}),
      });
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
      this.sessionRegistry.releaseActiveRun(toolSessionId, runId);
    }
  }
}

export class ReplyQuestionUseCase implements ReplyQuestionUseCasePort {
  private readonly handlers: ProviderCommandHandlers;
  private readonly interactionCoordinator: InteractionCoordinator;
  private readonly observation: RuntimeObservation;

  constructor(
    handlers: ProviderCommandHandlers,
    interactionCoordinator: InteractionCoordinator,
    observation: RuntimeObservation,
  ) {
    this.handlers = handlers;
    this.interactionCoordinator = interactionCoordinator;
    this.observation = observation;
  }

  async execute(command: Extract<RuntimeCommand, { kind: 'reply_question' }>): Promise<void> {
    this.observation.usecaseStarted('reply_question', command.traceId);
    try {
      this.interactionCoordinator.consume('question', command.source.payload.questionId);
      await this.handlers.replyQuestion({
        traceId: command.traceId,
        questionId: command.source.payload.questionId,
        answers: [[command.source.payload.answer]],
      });
      this.observation.usecaseSucceeded('reply_question', command.traceId);
    } catch (error) {
      this.observation.usecaseFailed('reply_question', command.traceId, error);
      throw error;
    }
  }
}

export class ReplyPermissionUseCase implements ReplyPermissionUseCasePort {
  private readonly handlers: ProviderCommandHandlers;
  private readonly interactionCoordinator: InteractionCoordinator;
  private readonly observation: RuntimeObservation;

  constructor(
    handlers: ProviderCommandHandlers,
    interactionCoordinator: InteractionCoordinator,
    observation: RuntimeObservation,
  ) {
    this.handlers = handlers;
    this.interactionCoordinator = interactionCoordinator;
    this.observation = observation;
  }

  async execute(command: Extract<RuntimeCommand, { kind: 'reply_permission' }>): Promise<void> {
    this.observation.usecaseStarted('reply_permission', command.traceId);
    try {
      this.interactionCoordinator.consume('permission', command.source.payload.permissionId);
      await this.handlers.replyPermission({
        traceId: command.traceId,
        permissionId: command.source.payload.permissionId,
        reply: command.source.payload.response,
      });
      this.observation.usecaseSucceeded('reply_permission', command.traceId);
    } catch (error) {
      this.observation.usecaseFailed('reply_permission', command.traceId, error);
      throw error;
    }
  }
}

export class CloseSessionUseCase implements CloseSessionUseCasePort {
  private readonly handlers: ProviderCommandHandlers;
  private readonly sessionRegistry: SessionRuntimeRegistry;
  private readonly interactionCoordinator: InteractionCoordinator;
  private readonly observation: RuntimeObservation;

  constructor(
    handlers: ProviderCommandHandlers,
    sessionRegistry: SessionRuntimeRegistry,
    interactionCoordinator: InteractionCoordinator,
    observation: RuntimeObservation,
  ) {
    this.handlers = handlers;
    this.sessionRegistry = sessionRegistry;
    this.interactionCoordinator = interactionCoordinator;
    this.observation = observation;
  }

  async execute(command: Extract<RuntimeCommand, { kind: 'close_session' }>): Promise<void> {
    const context = { toolSessionId: command.source.payload.toolSessionId };
    this.observation.usecaseStarted('close_session', command.traceId, context);
    try {
      await this.handlers.closeSession({
        traceId: command.traceId,
        toolSessionId: command.source.payload.toolSessionId,
      });
      this.sessionRegistry.markClosed(command.source.payload.toolSessionId);
      this.interactionCoordinator.clearSession(command.source.payload.toolSessionId);
      this.sessionRegistry.delete(command.source.payload.toolSessionId);
      this.observation.usecaseSucceeded('close_session', command.traceId, context);
    } catch (error) {
      this.observation.usecaseFailed('close_session', command.traceId, error, undefined, context);
      throw error;
    }
  }
}

export class AbortExecutionUseCase implements AbortExecutionUseCasePort {
  private readonly handlers: ProviderCommandHandlers;
  private readonly sessionRegistry: SessionRuntimeRegistry;
  private readonly observation: RuntimeObservation;

  constructor(
    handlers: ProviderCommandHandlers,
    sessionRegistry: SessionRuntimeRegistry,
    observation: RuntimeObservation,
  ) {
    this.handlers = handlers;
    this.sessionRegistry = sessionRegistry;
    this.observation = observation;
  }

  async execute(command: Extract<RuntimeCommand, { kind: 'abort_execution' }>): Promise<void> {
    const record = this.sessionRegistry.get(command.source.payload.toolSessionId);
    const context = {
      toolSessionId: command.source.payload.toolSessionId,
      runId: record?.activeRunId,
    };
    this.observation.usecaseStarted('abort_execution', command.traceId, context);
    try {
      await this.handlers.abortExecution({
        traceId: command.traceId,
        toolSessionId: command.source.payload.toolSessionId,
        runId: record?.activeRunId,
      });
      this.sessionRegistry.markAborting(command.source.payload.toolSessionId);
      this.observation.usecaseSucceeded('abort_execution', command.traceId, context);
    } catch (error) {
      this.observation.usecaseFailed('abort_execution', command.traceId, error, undefined, context);
      throw error;
    }
  }
}
