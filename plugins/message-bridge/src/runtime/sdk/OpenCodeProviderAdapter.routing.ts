import type { ProviderRuntimeContext } from '@wecode/bridge-runtime-sdk';
import { getErrorMessage } from '../../utils/error.js';
import { asTrimmedString } from '../../utils/type-guards.js';
import type { SubagentSessionMapper } from '../../session/SubagentSessionMapper.js';
import type { HostEventPort } from '../../port/session-isolation/inbound/index.js';
import type { EventAnchorResolver } from './SdkChatControlPlane.js';
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
  ActiveProviderRunHandle,
  PartKindStore,
  ActiveRunRegistry,
} from './OpenCodeProviderAdapter.run.js';
import { EventTranslatorRegistry } from './OpenCodeProviderAdapter.translation.js';

type EventClass = 'run_scoped' | 'run_scoped_with_outbound_fallback' | 'run_adjacent_metadata' | 'control_metadata' | 'unsupported';

type EventRoutingState = {
  event: BridgeEvent;
  rawSessionId: string;
  resolution: Extract<SessionIdentityResolution, { kind: 'resolved' | 'resolved_fail_open' }>;
  eventClass: EventClass;
  activeRun?: ActiveProviderRunHandle;
  factSessionContext: FactSessionContext;
  runtimeContext: ProviderRuntimeContext | null;
  eventRouteSummary: Record<string, unknown>;
  translationContext: TranslationContext;
};

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

function compactFields(entries: Array<[string, unknown]>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, value] of entries) {
    const text = asTrimmedString(value);
    if (text) {
      result[name] = text;
    }
  }
  return result;
}

function summarizeMessageUpdatedIdentity(properties: Record<string, unknown> | undefined): Record<string, unknown> {
  return compactFields([['messageId', asObject(properties?.info)?.id]]);
}

function summarizePartDeltaIdentity(properties: Record<string, unknown> | undefined): Record<string, unknown> {
  return compactFields([['messageId', properties?.messageID], ['partId', properties?.partID]]);
}

function summarizePartUpdatedIdentity(properties: Record<string, unknown> | undefined): Record<string, unknown> {
  const part = asObject(properties?.part);
  return compactFields([['messageId', part?.messageID], ['partId', part?.id]]);
}

function summarizeQuestionAskedIdentity(properties: Record<string, unknown> | undefined): Record<string, unknown> {
  return compactFields([['questionId', properties?.id], ['messageId', asObject(properties?.tool)?.messageID]]);
}

function summarizePermissionAskedIdentity(properties: Record<string, unknown> | undefined): Record<string, unknown> {
  return compactFields([['permissionId', properties?.id], ['messageId', asObject(properties?.tool)?.messageID]]);
}

// 仅提取日志安全的事件身份字段；不要在这里承载 raw event -> fact 的翻译语义。
function summarizeEventIdentity(event: BridgeEvent): Record<string, unknown> {
  const properties = asObject(event.properties);
  switch (event.type) {
    case 'message.updated':
      return summarizeMessageUpdatedIdentity(properties);
    case 'message.part.delta':
      return summarizePartDeltaIdentity(properties);
    case 'message.part.updated':
      return summarizePartUpdatedIdentity(properties);
    case 'question.asked':
      return summarizeQuestionAskedIdentity(properties);
    case 'permission.asked':
      return summarizePermissionAskedIdentity(properties);
    case 'permission.replied': {
      return compactFields([['permissionId', properties?.requestID]]);
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

function classifyEvent(type: BridgeEvent['type']): EventClass {
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

type RawSessionLocator = (properties: Record<string, unknown> | undefined) => string | undefined;

const directSessionIdLocator: RawSessionLocator = (properties) => asTrimmedString(properties?.sessionID) ?? undefined;

const rawSessionLocators: Partial<Record<BridgeEvent['type'], RawSessionLocator>> = {
  'message.updated': (properties) => asTrimmedString(asObject(properties?.info)?.sessionID) ?? undefined,
  'message.part.delta': directSessionIdLocator,
  'message.part.updated': (properties) => asTrimmedString(asObject(properties?.part)?.sessionID) ?? undefined,
  'permission.asked': directSessionIdLocator,
  'permission.replied': directSessionIdLocator,
  'question.asked': directSessionIdLocator,
  'session.error': directSessionIdLocator,
  'session.updated': (properties) => asTrimmedString(asObject(properties?.info)?.id) ?? undefined,
};

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
    const locator = rawSessionLocators[event.type];
    return locator?.(asObject(event.properties));
  }
}

export class EventSessionIdentityResolver {
  constructor(private readonly dependencies: {
    subagentSessionMapper: SubagentSessionMapper;
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
    if (this.recordSessionCreatedIfNeeded(event)) {
      return true;
    }

    const routingState = await this.resolveRoutingState(event);
    if (!routingState) {
      return false;
    }
    this.logEventReceived(routingState);
    if (this.tryRouteToActiveRun(routingState)) {
      return true;
    }
    return this.tryRouteToOutbound(routingState);
  }

  private recordSessionCreatedIfNeeded(event: BridgeEvent): boolean {
    if (event.type !== 'session.created') {
      return false;
    }
    this.dependencies.sessionCreatedRecorder.record(event);
    return true;
  }

  private async resolveRoutingState(event: BridgeEvent): Promise<EventRoutingState | undefined> {
    const rawSessionId = this.dependencies.rawSessionLocator.locate(event);
    if (!rawSessionId) {
      return undefined;
    }
    const resolution = await this.dependencies.identityResolver.resolve(rawSessionId);
    if (!this.isResolvedIdentity(resolution, rawSessionId, event.type)) {
      return undefined;
    }
    if (resolution.kind === 'resolved_fail_open') {
      this.dependencies.logger.warn('provider_adapter.subagent_lookup_failed', {
        toolSessionId: resolution.rawSessionId,
        error: getErrorMessage(resolution.lookupFailedCause),
      });
    }

    const eventClass = classifyEvent(event.type);
    const activeRun = this.dependencies.activeRunRegistry.getHeadByHostSession(resolution.hostSessionId);
    const factSessionContext = this.buildFactSessionContext(resolution, activeRun);
    const runtimeContext = this.dependencies.getRuntimeContext();
    const eventRouteSummary = buildEventRouteSummary({
      event,
      rawSessionId,
      factSessionContext,
      hasActiveRun: Boolean(activeRun),
      activeRunId: activeRun?.runId,
    });
    const translationContext = this.buildTranslationContext(event, factSessionContext);
    return {
      event,
      rawSessionId,
      resolution,
      eventClass,
      ...(activeRun ? { activeRun } : {}),
      factSessionContext,
      runtimeContext,
      eventRouteSummary,
      translationContext,
    };
  }

  private isResolvedIdentity(
    resolution: SessionIdentityResolution,
    rawSessionId: string,
    eventType: BridgeEvent['type'],
  ): resolution is Extract<SessionIdentityResolution, { kind: 'resolved' | 'resolved_fail_open' }> {
    if (resolution.kind !== 'missing_session') {
      return true;
    }
    if (resolution.lookupFailedCause) {
      this.dependencies.logger.warn('provider_adapter.subagent_lookup_failed', {
        toolSessionId: resolution.rawSessionId ?? rawSessionId,
        error: getErrorMessage(resolution.lookupFailedCause),
      });
    }
    this.dependencies.logger.warn('provider_adapter.event_dropped_without_session_identity', {
      toolSessionId: resolution.rawSessionId ?? rawSessionId,
      eventType,
      reason: resolution.reason,
    });
    return false;
  }

  private buildFactSessionContext(
    resolution: Extract<SessionIdentityResolution, { kind: 'resolved' | 'resolved_fail_open' }>,
    activeRun: ActiveProviderRunHandle | undefined,
  ): FactSessionContext {
    return this.dependencies.factRoutingContextAssembler.assemble({
      resolution,
      anchorSessionId: activeRun?.anchorSessionId ?? resolution.hostSessionId,
    });
  }

  private buildTranslationContext(event: BridgeEvent, factSessionContext: FactSessionContext): TranslationContext {
    return {
      event,
      factSessionContext,
      assistantMessageState: this.dependencies.assistantMessageState,
      partKindState: this.dependencies.partKindState,
      diagnostics: this.dependencies.diagnostics,
      observation: this.dependencies.observation,
    };
  }

  private logEventReceived(routingState: EventRoutingState): void {
    this.dependencies.logger.debug?.('provider_adapter.event.received', {
      ...routingState.eventRouteSummary,
      hasRuntimeContext: Boolean(routingState.runtimeContext),
    });
  }

  private tryRouteToActiveRun(routingState: EventRoutingState): boolean {
    if (!routingState.activeRun || !this.canRouteToActiveRun(routingState.eventClass)) {
      return false;
    }
    const translation = this.dependencies.activeRunTranslatorRegistry.translate(routingState.translationContext);
    this.dependencies.logger.debug?.('provider_adapter.event.translation', {
      ...routingState.eventRouteSummary,
      anchorSessionId: routingState.factSessionContext.anchorSessionId,
      recognized: translation.recognized,
      factTypes: translation.facts.map((fact) => fact.type),
    });
    if (!translation.recognized) {
      return false;
    }
    routingState.activeRun.observeTrackingSession(routingState.factSessionContext.trackingSessionId);
    this.recordPendingInteractions(
      translation.facts,
      routingState.factSessionContext,
      routingState.resolution.hostSessionId,
    );
    routingState.activeRun.pushFacts(translation);
    this.dependencies.logger.debug?.('provider_adapter.event.routed_to_active_run', {
      eventType: routingState.event.type,
      factTypes: translation.facts.map((fact) => fact.type),
      toolSessionId: routingState.activeRun.anchorSessionId,
      runId: routingState.activeRun.runId,
    });
    return true;
  }

  private canRouteToActiveRun(eventClass: EventClass): boolean {
    return eventClass !== 'control_metadata' && eventClass !== 'unsupported';
  }

  private async tryRouteToOutbound(routingState: EventRoutingState): Promise<boolean> {
    if (routingState.eventClass !== 'run_scoped_with_outbound_fallback' || !routingState.runtimeContext) {
      return false;
    }

    const outboundTarget = this.dependencies.outboundTargetResolver.resolve(routingState.resolution.hostSessionId);
    if (!outboundTarget) {
      return false;
    }

    const factSessionContext = this.dependencies.factRoutingContextAssembler.assemble({
      resolution: routingState.resolution,
      anchorSessionId: outboundTarget.anchorSessionId,
    });
    const translation = this.dependencies.outboundTranslatorRegistry.translate(
      this.buildTranslationContext(routingState.event, factSessionContext),
    );
    this.dependencies.logger.debug?.('provider_adapter.event.translation', {
      ...routingState.eventRouteSummary,
      anchorSessionId: outboundTarget.anchorSessionId,
      recognized: translation.recognized,
      factTypes: translation.facts.map((fact) => fact.type),
    });
    if (!translation.recognized || translation.facts.length === 0 || !translation.envelopeMessageId) {
      return false;
    }

    await routingState.runtimeContext.outbound.emitOutboundMessage({
      toolSessionId: outboundTarget.anchorSessionId,
      messageId: translation.envelopeMessageId,
      trigger: 'system',
      facts: toAsyncFacts(translation.facts),
    });
    this.dependencies.logger.debug?.('provider_adapter.event.routed_to_outbound', {
      eventType: routingState.event.type,
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
