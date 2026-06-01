import type { ProviderRuntimeContext } from '@wecode/bridge-runtime-sdk';
import { getErrorMessage } from '../../utils/error.js';
import { asTrimmedString } from '../../utils/type-guards.js';
import type { SubagentSessionMapper } from '../../session/SubagentSessionMapper.js';
import type { HostEventPort } from '../../port/session-isolation/inbound/index.js';
import type {
  EventAnchorResolver,
} from './SdkChatControlPlane.js';
import type { BridgeEvent } from '../types.js';
import type { BridgeLogger } from '../AppLogger.js';
import type {
  FactSessionContext,
  OutboundTargetResolverPort,
  PendingInteractionRecorderPort,
  ProtocolDiagnosticPort,
  SessionIdentityResolution,
  TranslationObservationPort,
  TranslationContext,
} from './OpenCodeProviderAdapter.types.js';
import type {
  AssistantMessageStateStore,
  PartKindStore,
  ActiveRunRegistry,
} from './OpenCodeProviderAdapter.run.js';
import { EventTranslatorRegistry } from './OpenCodeProviderAdapter.translation.js';

function toAsyncFacts<T>(facts: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const fact of facts) {
        yield fact;
      }
    },
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

// 仅提取日志安全的事件身份字段；不要在这里承载 raw event -> fact 的翻译语义。
function summarizeEventIdentity(event: BridgeEvent): Record<string, unknown> {
  const properties = asObject(event.properties);
  switch (event.type) {
    case 'message.updated': {
      const info = asObject(properties?.info);
      const messageId = asTrimmedString(info?.id);
      return {
        ...(messageId ? { messageId } : {}),
      };
    }
    case 'message.part.delta': {
      const messageId = asTrimmedString(properties?.messageID);
      const partId = asTrimmedString(properties?.partID);
      return {
        ...(messageId ? { messageId } : {}),
        ...(partId ? { partId } : {}),
      };
    }
    case 'message.part.updated': {
      const part = asObject(properties?.part);
      const messageId = asTrimmedString(part?.messageID);
      const partId = asTrimmedString(part?.id);
      return {
        ...(messageId ? { messageId } : {}),
        ...(partId ? { partId } : {}),
      };
    }
    case 'question.asked': {
      const questionId = asTrimmedString(properties?.id);
      const messageId = asTrimmedString(asObject(properties?.tool)?.messageID);
      return {
        ...(questionId ? { questionId } : {}),
        ...(messageId ? { messageId } : {}),
      };
    }
    case 'permission.asked': {
      const permissionId = asTrimmedString(properties?.id);
      const messageId = asTrimmedString(asObject(properties?.tool)?.messageID);
      return {
        ...(permissionId ? { permissionId } : {}),
        ...(messageId ? { messageId } : {}),
      };
    }
    case 'permission.replied': {
      const permissionId = asTrimmedString(properties?.requestID);
      return {
        ...(permissionId ? { permissionId } : {}),
      };
    }
    default:
      return {};
  }
}

function buildEventRouteSummary(input: {
  event: BridgeEvent;
  rawSessionId: string;
  factSessionContext: FactSessionContext;
  hasActiveRun: boolean;
  activeRunId?: string;
}): Record<string, unknown> {
  return {
    eventType: input.event.type,
    rawSessionId: input.rawSessionId,
    anchorSessionId: input.factSessionContext.anchorSessionId,
    hasActiveRun: input.hasActiveRun,
    activeRunId: input.activeRunId,
    ...(input.factSessionContext.trackingSessionId !== input.rawSessionId
      ? { trackingSessionId: input.factSessionContext.trackingSessionId }
      : {}),
    ...(input.factSessionContext.subagentSessionId
      ? { subagentSessionId: input.factSessionContext.subagentSessionId }
      : {}),
    ...(input.factSessionContext.subagentName ? { subagentName: input.factSessionContext.subagentName } : {}),
    ...summarizeEventIdentity(input.event),
  };
}

function classifyEvent(type: BridgeEvent['type']):
  | 'run_scoped'
  | 'run_scoped_with_outbound_fallback'
  | 'run_adjacent_metadata'
  | 'control_metadata'
  | 'unsupported' {
  switch (type) {
    case 'message.updated':
    case 'message.part.delta':
    case 'message.part.updated':
    case 'question.asked':
    case 'permission.asked':
      return 'run_scoped';
    case 'session.error':
      return 'run_scoped_with_outbound_fallback';
    case 'session.updated':
    case 'permission.replied':
      return 'run_adjacent_metadata';
    case 'session.created':
    case 'session.deleted':
      return 'control_metadata';
    default:
      return 'unsupported';
  }
}

export class DefaultProtocolDiagnosticPort implements ProtocolDiagnosticPort {
  constructor(private readonly logger: BridgeLogger) {}

  warn(code: string, payload: Record<string, unknown>): void {
    this.logger.warn('provider_adapter.protocol_diagnostic', {
      code,
      ...payload,
    });
  }
}

export class DefaultTranslationObservationPort implements TranslationObservationPort {
  constructor(private readonly logger: BridgeLogger) {}

  sessionUpdatedIgnored(reason: 'missing_session_id' | 'missing_title'): void {
    this.logger.warn('provider_adapter.session_updated_ignored', {
      reason,
    });
  }
}

export class EventRawSessionLocator {
  locate(event: BridgeEvent): string | undefined {
    const properties = asObject(event.properties);
    switch (event.type) {
      case 'message.updated':
        return asTrimmedString(asObject(properties?.info)?.sessionID) ?? undefined;
      case 'message.part.delta':
      case 'question.asked':
      case 'permission.asked':
      case 'permission.replied':
      case 'session.error':
        return asTrimmedString(properties?.sessionID) ?? undefined;
      case 'message.part.updated':
        return asTrimmedString(asObject(properties?.part)?.sessionID) ?? undefined;
      case 'session.updated':
        return asTrimmedString(asObject(properties?.info)?.id) ?? undefined;
      default:
        return undefined;
    }
  }
}

export class EventSessionIdentityResolver {
  constructor(private readonly dependencies: {
    subagentSessionMapper: SubagentSessionMapper;
    eventAnchorResolver: EventAnchorResolver;
  }) {}

  async resolve(rawSessionId: string): Promise<SessionIdentityResolution> {
    const resolution = await this.dependencies.subagentSessionMapper.resolve(rawSessionId);
    if (resolution.status === 'mapped') {
      return {
        kind: 'resolved',
        rawSessionId,
        trackingSessionId: rawSessionId,
        hostSessionId: resolution.mapping.parentSessionId,
        subagentSessionId: resolution.mapping.childSessionId,
        ...(resolution.mapping.agentName ? { subagentName: resolution.mapping.agentName } : {}),
      };
    }

    if (resolution.status === 'lookup_failed') {
      return {
        kind: 'resolved_fail_open',
        rawSessionId,
        trackingSessionId: rawSessionId,
        hostSessionId: rawSessionId,
        lookupFailedCause: resolution.error,
      };
    }

    return {
      kind: 'resolved',
      rawSessionId,
      trackingSessionId: rawSessionId,
      hostSessionId: rawSessionId,
    };
  }
}

export class FactRoutingContextAssembler {
  assemble(input: {
    resolution: Extract<SessionIdentityResolution, { kind: 'resolved' | 'resolved_fail_open' }>;
    anchorSessionId: string;
  }): FactSessionContext {
    return {
      anchorSessionId: input.anchorSessionId,
      trackingSessionId: input.resolution.trackingSessionId,
      ...('subagentSessionId' in input.resolution && input.resolution.subagentSessionId
        ? { subagentSessionId: input.resolution.subagentSessionId }
        : {}),
      ...('subagentName' in input.resolution && input.resolution.subagentName
        ? { subagentName: input.resolution.subagentName }
        : {}),
    };
  }
}

export class DefaultOutboundTargetResolver implements OutboundTargetResolverPort {
  constructor(private readonly dependencies: { eventAnchorResolver: EventAnchorResolver }) {}

  resolve(hostSessionId: string): { anchorSessionId: string } | undefined {
    const resolved = this.dependencies.eventAnchorResolver.resolveForEvent(hostSessionId);
    return resolved?.anchor ? { anchorSessionId: resolved.anchor } : undefined;
  }
}

export class SessionCreatedRecorder {
  constructor(private readonly dependencies: {
    subagentSessionMapper: SubagentSessionMapper;
  }) {}

  record(event: BridgeEvent): void {
    const properties = asObject(event.properties);
    const info = asObject(properties?.info);
    const childSessionId = asTrimmedString(info?.id);
    const agentName = asTrimmedString(info?.title);
    if (!childSessionId) {
      return;
    }

    const parentSessionId = asTrimmedString(info?.parentID);
    this.dependencies.subagentSessionMapper.recordSessionCreated({
      childSessionId,
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(agentName ? { agentName } : {}),
    });
  }
}

export class ProviderEventCoordinator {
  constructor(private readonly dependencies: {
    logger: BridgeLogger;
    diagnostics: ProtocolDiagnosticPort;
    observation: TranslationObservationPort;
    rawSessionLocator: EventRawSessionLocator;
    identityResolver: EventSessionIdentityResolver;
    factRoutingContextAssembler: FactRoutingContextAssembler;
    sessionCreatedRecorder: SessionCreatedRecorder;
    activeRunRegistry: ActiveRunRegistry;
    outboundTargetResolver: OutboundTargetResolverPort;
    assistantMessageState: AssistantMessageStateStore;
    partKindState: PartKindStore;
    activeRunTranslatorRegistry: EventTranslatorRegistry;
    outboundTranslatorRegistry: EventTranslatorRegistry;
    sessionIsolationHostEventPort?: HostEventPort;
    pendingInteractionRecorder?: PendingInteractionRecorderPort;
    getRuntimeContext: () => ProviderRuntimeContext | null;
  }) {}

  async handleEvent(event: BridgeEvent): Promise<boolean> {
    await this.observeSessionIsolationHostEvent(event);

    if (event.type === 'session.created') {
      this.dependencies.sessionCreatedRecorder.record(event);
      return true;
    }

    const rawSessionId = this.dependencies.rawSessionLocator.locate(event);
    if (!rawSessionId) {
      return false;
    }

    const resolution = await this.dependencies.identityResolver.resolve(rawSessionId);
    if (resolution.kind === 'missing_session') {
      if (resolution.lookupFailedCause) {
        this.dependencies.logger.warn('provider_adapter.subagent_lookup_failed', {
          toolSessionId: resolution.rawSessionId ?? rawSessionId,
          error: getErrorMessage(resolution.lookupFailedCause),
        });
      }
      this.dependencies.logger.warn('provider_adapter.event_dropped_without_session_identity', {
        toolSessionId: resolution.rawSessionId ?? rawSessionId,
        eventType: event.type,
        reason: resolution.reason,
      });
      return false;
    }

    if (resolution.kind === 'resolved_fail_open') {
      this.dependencies.logger.warn('provider_adapter.subagent_lookup_failed', {
        toolSessionId: resolution.rawSessionId,
        error: getErrorMessage(resolution.lookupFailedCause),
      });
    }

    const eventClass = classifyEvent(event.type);
    const activeRun = this.dependencies.activeRunRegistry.getHeadByHostSession(resolution.hostSessionId);
    const activeRunFactSessionContext = activeRun
      ? this.dependencies.factRoutingContextAssembler.assemble({
          resolution,
          anchorSessionId: activeRun.anchorSessionId,
        })
      : undefined;
    const factSessionContext = activeRunFactSessionContext ?? this.dependencies.factRoutingContextAssembler.assemble({
      resolution,
      anchorSessionId: resolution.hostSessionId,
    });
    const runtimeContext = this.dependencies.getRuntimeContext();
    const eventRouteSummary = buildEventRouteSummary({
      event,
      rawSessionId,
      factSessionContext,
      hasActiveRun: Boolean(activeRun),
      activeRunId: activeRun?.runId,
    });
    this.dependencies.logger.debug?.('provider_adapter.event.received', {
      ...eventRouteSummary,
      hasRuntimeContext: Boolean(runtimeContext),
    });

    const translationContext: TranslationContext = {
      event,
      factSessionContext,
      assistantMessageState: this.dependencies.assistantMessageState,
      partKindState: this.dependencies.partKindState,
      diagnostics: this.dependencies.diagnostics,
      observation: this.dependencies.observation,
    };

    if (
      activeRun
      && eventClass !== 'control_metadata'
      && eventClass !== 'unsupported'
      && activeRunFactSessionContext
    ) {
      const activeRunTranslationContext: TranslationContext = {
        ...translationContext,
        factSessionContext: activeRunFactSessionContext,
      };
      activeRun.observeTrackingSession(activeRunFactSessionContext.trackingSessionId);
      const translation = this.dependencies.activeRunTranslatorRegistry.translate(activeRunTranslationContext);
      this.dependencies.logger.debug?.('provider_adapter.event.translation', {
        ...eventRouteSummary,
        anchorSessionId: activeRunFactSessionContext.anchorSessionId,
        recognized: translation.recognized,
        factTypes: translation.facts.map((fact) => fact.type),
      });
      if (translation.recognized) {
        this.recordPendingInteractions(translation.facts, activeRunFactSessionContext, resolution.hostSessionId);
        activeRun.pushFacts(translation);
        this.dependencies.logger.debug?.('provider_adapter.event.routed_to_active_run', {
          eventType: event.type,
          factTypes: translation.facts.map((fact) => fact.type),
          toolSessionId: activeRun.anchorSessionId,
          runId: activeRun.runId,
        });
        return true;
      }
    }

    if (eventClass !== 'run_scoped_with_outbound_fallback') {
      return false;
    }

    const outboundTarget = this.dependencies.outboundTargetResolver.resolve(resolution.hostSessionId);
    if (!outboundTarget || !runtimeContext) {
      return false;
    }

    const outboundFactSessionContext = this.dependencies.factRoutingContextAssembler.assemble({
      resolution,
      anchorSessionId: outboundTarget.anchorSessionId,
    });
    const outboundTranslationContext: TranslationContext = {
      ...translationContext,
      factSessionContext: outboundFactSessionContext,
    };
    const translation = this.dependencies.outboundTranslatorRegistry.translate(outboundTranslationContext);
    this.dependencies.logger.debug?.('provider_adapter.event.translation', {
      ...eventRouteSummary,
      anchorSessionId: outboundTarget.anchorSessionId,
      recognized: translation.recognized,
      factTypes: translation.facts.map((fact) => fact.type),
    });
    if (!translation.recognized || translation.facts.length === 0 || !translation.envelopeMessageId) {
      return false;
    }

    await runtimeContext.outbound.emitOutboundMessage({
      toolSessionId: outboundTarget.anchorSessionId,
      messageId: translation.envelopeMessageId,
      trigger: 'system',
      facts: toAsyncFacts(translation.facts),
    });
    this.dependencies.logger.debug?.('provider_adapter.event.routed_to_outbound', {
      eventType: event.type,
      factTypes: translation.facts.map((fact) => fact.type),
      toolSessionId: outboundTarget.anchorSessionId,
      messageId: translation.envelopeMessageId,
    });
    return true;
  }

  private async observeSessionIsolationHostEvent(event: BridgeEvent): Promise<void> {
    const hostEventPort = this.dependencies.sessionIsolationHostEventPort;
    if (!hostEventPort) {
      return;
    }
    try {
      const result = await hostEventPort.handle(event);
      this.dependencies.logger.debug?.('provider_adapter.session_isolation_event_observed', {
        eventType: event.type,
        resultKind: result.kind,
      });
    } catch (error) {
      this.dependencies.logger.warn('provider_adapter.session_isolation_event_observer_failed', {
        eventType: event.type,
        error: getErrorMessage(error),
      });
    }
  }

  private recordPendingInteractions(
    facts: { type: string }[],
    factSessionContext: FactSessionContext,
    hostSessionId: string,
  ): void {
    const recorder = this.dependencies.pendingInteractionRecorder;
    if (!recorder) {
      return;
    }
    for (const fact of facts) {
      if (fact.type === 'question.ask') {
        const questionId = (fact as { questionId?: unknown }).questionId;
        if (typeof questionId === 'string' && questionId.trim().length > 0) {
          recorder.record({
            kind: 'question',
            tokenId: questionId,
            toolSessionId: factSessionContext.anchorSessionId,
            hostSessionId,
          });
        }
      }
      if (fact.type === 'permission.ask') {
        const permissionId = (fact as { permissionId?: unknown }).permissionId;
        if (typeof permissionId === 'string' && permissionId.trim().length > 0) {
          recorder.record({
            kind: 'permission',
            tokenId: permissionId,
            toolSessionId: factSessionContext.anchorSessionId,
            hostSessionId,
          });
        }
      }
    }
  }
}
