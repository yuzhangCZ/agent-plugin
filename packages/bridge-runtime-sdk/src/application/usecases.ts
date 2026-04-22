import { randomUUID } from 'node:crypto';

import type { RuntimeCommand } from '../domain/runtime-command.ts';
import type { ProviderCommandHandlers } from './provider-api-adapter.ts';
import type {
  GatewayCommandResultProjector,
  GatewayOutboundSink,
} from './projectors.ts';
import type {
  PendingInteractionRegistry,
  SessionRuntimeRegistry,
} from './registries.ts';
import { InteractionCoordinator, RequestRunCoordinator } from './coordinators.ts';
import type { RuntimeTraceCollector } from './runtime-trace.ts';

export interface RuntimeUseCase {
  execute(command: RuntimeCommand): Promise<void>;
}

export class QueryStatusUseCase implements RuntimeUseCase {
  private readonly handlers: ProviderCommandHandlers;
  private readonly sink: GatewayOutboundSink;
  private readonly projector: GatewayCommandResultProjector;
  private readonly trace: RuntimeTraceCollector;

  constructor(
    handlers: ProviderCommandHandlers,
    sink: GatewayOutboundSink,
    projector: GatewayCommandResultProjector,
    trace: RuntimeTraceCollector,
  ) {
    this.handlers = handlers;
    this.sink = sink;
    this.projector = projector;
    this.trace = trace;
  }

  async execute(command: Extract<RuntimeCommand, { kind: 'query_status' }>): Promise<void> {
    const result = await this.handlers.queryStatus({ traceId: command.traceId });
    const uplink = this.projector.projectStatus({ online: result.online });
    this.trace.recordUplink(uplink);
    await this.sink.send(uplink);
  }
}

export class CreateSessionUseCase implements RuntimeUseCase {
  private readonly handlers: ProviderCommandHandlers;
  private readonly sessionRegistry: SessionRuntimeRegistry;
  private readonly sink: GatewayOutboundSink;
  private readonly projector: GatewayCommandResultProjector;
  private readonly trace: RuntimeTraceCollector;

  constructor(
    handlers: ProviderCommandHandlers,
    sessionRegistry: SessionRuntimeRegistry,
    sink: GatewayOutboundSink,
    projector: GatewayCommandResultProjector,
    trace: RuntimeTraceCollector,
  ) {
    this.handlers = handlers;
    this.sessionRegistry = sessionRegistry;
    this.sink = sink;
    this.projector = projector;
    this.trace = trace;
  }

  async execute(command: Extract<RuntimeCommand, { kind: 'create_session' }>): Promise<void> {
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
    this.trace.recordUplink(uplink);
    await this.sink.send(uplink);
  }
}

export class StartRequestRunUseCase implements RuntimeUseCase {
  private readonly handlers: ProviderCommandHandlers;
  private readonly sessionRegistry: SessionRuntimeRegistry;
  private readonly coordinator: RequestRunCoordinator;

  constructor(
    handlers: ProviderCommandHandlers,
    sessionRegistry: SessionRuntimeRegistry,
    coordinator: RequestRunCoordinator,
  ) {
    this.handlers = handlers;
    this.sessionRegistry = sessionRegistry;
    this.coordinator = coordinator;
  }

  async execute(command: Extract<RuntimeCommand, { kind: 'start_request_run' }>): Promise<void> {
    const runId = randomUUID();
    const toolSessionId = command.source.payload.toolSessionId;
    const acquired = this.sessionRegistry.acquireActiveRun(toolSessionId, runId);
    if (!acquired.ok) {
      throw new Error(`toolSessionId already has an active request run: ${toolSessionId}`);
    }

    this.sessionRegistry.ensure({
      toolSessionId,
      welinkSessionId: command.source.welinkSessionId,
    });

    try {
      const run = await this.handlers.startRequestRun({
        traceId: command.traceId,
        runId,
        toolSessionId,
        text: command.source.payload.text,
        assistantId: command.source.payload.assistantId,
      });
      await this.coordinator.executeRun({
        toolSessionId,
        welinkSessionId: command.source.welinkSessionId,
        runId,
        run,
      });
    } finally {
      this.sessionRegistry.releaseActiveRun(toolSessionId, runId);
    }
  }
}

export class ReplyQuestionUseCase implements RuntimeUseCase {
  private readonly handlers: ProviderCommandHandlers;
  private readonly interactionCoordinator: InteractionCoordinator;

  constructor(handlers: ProviderCommandHandlers, interactionCoordinator: InteractionCoordinator) {
    this.handlers = handlers;
    this.interactionCoordinator = interactionCoordinator;
  }

  async execute(command: Extract<RuntimeCommand, { kind: 'reply_question' }>): Promise<void> {
    const toolCallId = command.source.payload.toolCallId;
    if (!toolCallId) {
      throw new Error('question_reply requires toolCallId');
    }
    this.interactionCoordinator.consume(command.source.payload.toolSessionId, 'question', toolCallId);
    await this.handlers.replyQuestion({
      traceId: command.traceId,
      toolSessionId: command.source.payload.toolSessionId,
      toolCallId,
      answer: command.source.payload.answer,
    });
  }
}

export class ReplyPermissionUseCase implements RuntimeUseCase {
  private readonly handlers: ProviderCommandHandlers;
  private readonly interactionCoordinator: InteractionCoordinator;

  constructor(handlers: ProviderCommandHandlers, interactionCoordinator: InteractionCoordinator) {
    this.handlers = handlers;
    this.interactionCoordinator = interactionCoordinator;
  }

  async execute(command: Extract<RuntimeCommand, { kind: 'reply_permission' }>): Promise<void> {
    this.interactionCoordinator.consume(
      command.source.payload.toolSessionId,
      'permission',
      command.source.payload.permissionId,
    );
    await this.handlers.replyPermission({
      traceId: command.traceId,
      toolSessionId: command.source.payload.toolSessionId,
      permissionId: command.source.payload.permissionId,
      response: command.source.payload.response,
    });
  }
}

export class CloseSessionUseCase implements RuntimeUseCase {
  private readonly handlers: ProviderCommandHandlers;
  private readonly sessionRegistry: SessionRuntimeRegistry;
  private readonly interactionCoordinator: InteractionCoordinator;

  constructor(
    handlers: ProviderCommandHandlers,
    sessionRegistry: SessionRuntimeRegistry,
    interactionCoordinator: InteractionCoordinator,
  ) {
    this.handlers = handlers;
    this.sessionRegistry = sessionRegistry;
    this.interactionCoordinator = interactionCoordinator;
  }

  async execute(command: Extract<RuntimeCommand, { kind: 'close_session' }>): Promise<void> {
    await this.handlers.closeSession({
      traceId: command.traceId,
      toolSessionId: command.source.payload.toolSessionId,
    });
    this.sessionRegistry.markClosed(command.source.payload.toolSessionId);
    this.interactionCoordinator.clearSession(command.source.payload.toolSessionId);
    this.sessionRegistry.delete(command.source.payload.toolSessionId);
  }
}

export class AbortExecutionUseCase implements RuntimeUseCase {
  private readonly handlers: ProviderCommandHandlers;
  private readonly sessionRegistry: SessionRuntimeRegistry;

  constructor(handlers: ProviderCommandHandlers, sessionRegistry: SessionRuntimeRegistry) {
    this.handlers = handlers;
    this.sessionRegistry = sessionRegistry;
  }

  async execute(command: Extract<RuntimeCommand, { kind: 'abort_execution' }>): Promise<void> {
    const record = this.sessionRegistry.get(command.source.payload.toolSessionId);
    await this.handlers.abortExecution({
      traceId: command.traceId,
      toolSessionId: command.source.payload.toolSessionId,
      runId: record?.activeRunId,
    });
    this.sessionRegistry.markAborting(command.source.payload.toolSessionId);
  }
}
