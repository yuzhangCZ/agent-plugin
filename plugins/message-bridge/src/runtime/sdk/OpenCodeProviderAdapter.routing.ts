import type { ProviderRuntimeContext } from '../../../../../packages/bridge-runtime-sdk/src/index.ts';
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
      const anchorResolution = this.dependencies.eventAnchorResolver.resolveForEvent(
        resolution.mapping.parentSessionId,
      );
      if (!anchorResolution?.anchor) {
        return {
          kind: 'anchor_missing',
          rawSessionId,
        };
      }
      return {
        kind: 'resolved',
        rawSessionId,
        anchorSessionId: anchorResolution.anchor,
        trackingSessionId: rawSessionId,
        hostSessionId: resolution.mapping.parentSessionId,
        subagentSessionId: resolution.mapping.childSessionId,
        ...(resolution.mapping.agentName ? { subagentName: resolution.mapping.agentName } : {}),
      };
    }

    if (resolution.status === 'lookup_failed') {
      const anchorResolution = this.dependencies.eventAnchorResolver.resolveForEvent(rawSessionId);
      if (!anchorResolution?.anchor) {
        return {
          kind: 'anchor_missing',
          rawSessionId,
          lookupFailedCause: resolution.error,
        };
      }
      return {
        kind: 'resolved_fail_open',
        rawSessionId,
        anchorSessionId: anchorResolution.anchor,
        trackingSessionId: rawSessionId,
        hostSessionId: rawSessionId,
        lookupFailedCause: resolution.error,
      };
    }

    const anchorResolution = this.dependencies.eventAnchorResolver.resolveForEvent(rawSessionId);
    if (!anchorResolution?.anchor) {
      return {
        kind: 'anchor_missing',
        rawSessionId,
      };
    }
    return {
      kind: 'resolved',
      rawSessionId,
      anchorSessionId: anchorResolution.anchor,
      trackingSessionId: rawSessionId,
      hostSessionId: rawSessionId,
    };
  }
}

export class FactRoutingContextAssembler {
  assemble(
    resolution: Extract<SessionIdentityResolution, { kind: 'resolved' | 'resolved_fail_open' }>,
  ): FactSessionContext {
    return {
      anchorSessionId: resolution.anchorSessionId,
      trackingSessionId: resolution.trackingSessionId,
      ...('subagentSessionId' in resolution && resolution.subagentSessionId
        ? { subagentSessionId: resolution.subagentSessionId }
        : {}),
      ...('subagentName' in resolution && resolution.subagentName
        ? { subagentName: resolution.subagentName }
        : {}),
    };
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
    if (resolution.kind === 'anchor_missing') {
      if (resolution.lookupFailedCause) {
        this.dependencies.logger.warn('provider_adapter.subagent_lookup_failed', {
          toolSessionId: resolution.rawSessionId,
          error: getErrorMessage(resolution.lookupFailedCause),
        });
      }
      this.dependencies.logger.warn('provider_adapter.event_dropped_without_anchor', {
        toolSessionId: resolution.rawSessionId,
        eventType: event.type,
      });
      return false;
    }

    if (resolution.kind === 'resolved_fail_open') {
      this.dependencies.logger.warn('provider_adapter.subagent_lookup_failed', {
        toolSessionId: resolution.rawSessionId,
        error: getErrorMessage(resolution.lookupFailedCause),
      });
    }

    const factSessionContext = this.dependencies.factRoutingContextAssembler.assemble(resolution);
    const hasActiveRun = this.dependencies.activeRunRegistry.has(factSessionContext.anchorSessionId);
    const runtimeContext = this.dependencies.getRuntimeContext();
    this.dependencies.logger.debug?.('provider_adapter.event.received', {
      eventType: event.type,
      translated:
        this.dependencies.activeRunTranslatorRegistry.recognizes(event.type)
        || this.dependencies.outboundTranslatorRegistry.recognizes(event.type),
      toolSessionId: rawSessionId,
      resolvedToolSessionId: factSessionContext.anchorSessionId,
      hasActiveRun,
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

    const activeRun = this.dependencies.activeRunRegistry.get(factSessionContext.anchorSessionId);
    if (activeRun) {
      activeRun.observeTrackingSession(factSessionContext.trackingSessionId);
      const translation = this.dependencies.activeRunTranslatorRegistry.translate(translationContext);
      if (translation.recognized) {
        this.recordPendingInteractions(translation.facts, factSessionContext, resolution.hostSessionId);
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

    if (!runtimeContext) {
      return false;
    }

    const translation = this.dependencies.outboundTranslatorRegistry.translate(translationContext);
    if (!translation.recognized || !translation.toolSessionId || translation.facts.length === 0 || !translation.envelopeMessageId) {
      return false;
    }

    await runtimeContext.outbound.emitOutboundMessage({
      toolSessionId: translation.toolSessionId,
      messageId: translation.envelopeMessageId,
      trigger: 'system',
      facts: toAsyncFacts(translation.facts),
    });
    this.dependencies.logger.debug?.('provider_adapter.event.routed_to_outbound', {
      eventType: event.type,
      factTypes: translation.facts.map((fact) => fact.type),
      toolSessionId: translation.toolSessionId,
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
