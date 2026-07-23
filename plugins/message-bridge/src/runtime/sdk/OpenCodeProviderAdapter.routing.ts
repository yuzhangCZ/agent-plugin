/* eslint-disable max-classes-per-file -- 事件路由策略集中共享解析上下文，拆分需独立架构任务。 */
import { getErrorMessage } from '../../utils/error.js';
import { asTrimmedString } from '../../utils/type-guards.js';
import type { SubagentSessionMapper } from '../../session/SubagentSessionMapper.js';
import type { HostEventPort } from '../../port/session-isolation/inbound/index.js';
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
  ActiveProviderRunHandle,
  PartKindStore,
  ActiveRunRegistry,
} from './OpenCodeProviderAdapter.run.js';
import { EventTranslatorRegistry } from './OpenCodeProviderAdapter.translation.js';

type EventClass = 'run_scoped' | 'run_adjacent_metadata' | 'control_metadata' | 'unsupported';

type EventRoutingState = {
  event: BridgeEvent;
  rawSessionId: string;
  resolution: Extract<SessionIdentityResolution, { kind: 'resolved' | 'resolved_fail_open' }>;
  eventClass: EventClass;
  activeRun?: ActiveProviderRunHandle;
  factSessionContext: FactSessionContext;
  eventRouteSummary: Record<string, unknown>;
  translationContext: TranslationContext;
};

type EventDropReason =
  | 'missing_raw_session_id'
  | 'missing_active_run'
  | 'unsupported_event'
  | 'missing_session_identity';

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
    case 'permission.replied':
    case 'session.error':
      return 'run_scoped';
    case 'session.updated':
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

/**
 * 协议诊断日志出口。
 * @remarks
 * translator 只报告诊断语义，日志级别和统一字段由该 port 负责收口。
 */
export class DefaultProtocolDiagnosticPort implements ProtocolDiagnosticPort {
  constructor(private readonly logger: BridgeLogger) {}

  warn(code: string, payload: Record<string, unknown>): void {
    this.logger.warn('provider_adapter.protocol_diagnostic', {
      code,
      ...payload,
    });
  }
}

/**
 * raw event 翻译过程中的非 fact 观察出口。
 * @remarks
 * 用于记录被识别但不产出 fact 的元数据事件，避免 translator 直接依赖具体日志实现。
 */
export class DefaultTranslationObservationPort implements TranslationObservationPort {
  constructor(private readonly logger: BridgeLogger) {}

  sessionUpdatedIgnored(reason: 'missing_session_id' | 'missing_title'): void {
    this.logger.warn('provider_adapter.session_updated_ignored', {
      reason,
    });
  }
}

/**
 * 将 raw event 中不同结构的 session 字段统一抽取为宿主 session id。
 * @remarks
 * 这里只做身份定位，不读取消息正文，也不承担 raw event -> fact 翻译。
 */
export class EventRawSessionLocator {
  locate(event: BridgeEvent): string | undefined {
    const locator = rawSessionLocators[event.type];
    return locator?.(asObject(event.properties));
  }
}

/**
 * 将宿主 session id 解析为 fact 路由身份。
 * @remarks
 * 子 agent 会话映射失败时返回 fail-open 身份，保证宿主事件不会因为本地索引异常被硬丢弃。
 */
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

/**
 * 组装 fact 上的会话路由字段。
 * @remarks
 * `anchorSessionId` 是对外展示会话，`trackingSessionId` 是本地生命周期状态跟踪会话。
 */
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

/**
 * 记录 `session.created` 中的父子会话关系。
 * @remarks
 * 该类只更新子 agent 映射，不产生 provider fact。
 */
export class SessionCreatedRecorder {
  constructor(private readonly dependencies: {
    logger: BridgeLogger;
    subagentSessionMapper: SubagentSessionMapper;
  }) {}

  record(event: BridgeEvent): void {
    const properties = asObject(event.properties);
    const info = asObject(properties?.info);
    const childSessionId = asTrimmedString(info?.id);
    const agentName = asTrimmedString(info?.title);
    if (!childSessionId) {
      this.dependencies.logger.debug?.('provider_adapter.session_created_ignored', {
        eventType: event.type,
        reason: 'missing_child_session_id',
      });
      return;
    }

    const parentSessionId = asTrimmedString(info?.parentID);
    this.dependencies.subagentSessionMapper.recordSessionCreated({
      childSessionId,
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(agentName ? { agentName } : {}),
    });
    this.dependencies.logger.debug?.('provider_adapter.session_created_recorded', {
      eventType: event.type,
      childSessionId,
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(agentName ? { agentName } : {}),
    });
  }
}

/**
 * OpenCode raw event 的路由协调器。
 * @remarks
 * 负责 session 身份解析、active run 路由和诊断日志；
 * 具体 raw event -> fact 映射由 translator registry 完成。
 * 无 active run 的事件按 `missing_active_run` 丢弃。
 */
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
    sessionIsolationHostEventPort?: HostEventPort;
    pendingInteractionRecorder?: PendingInteractionRecorderPort;
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
    return this.tryRouteToActiveRun(routingState);
  }

  private recordSessionCreatedIfNeeded(event: BridgeEvent): boolean {
    if (event.type !== 'session.created') {
      return false;
    }
    this.dependencies.sessionCreatedRecorder.record(event);
    return true;
  }

  private async resolveRoutingState(event: BridgeEvent): Promise<EventRoutingState | undefined> {
    const eventClass = classifyEvent(event.type);
    if (eventClass === 'unsupported') {
      const properties = asObject(event.properties);
      const rawSessionId = asTrimmedString(properties?.sessionID);
      this.logEventDropped({
        event,
        reason: 'unsupported_event',
        routeSummary: {
          eventType: event.type,
          rawSessionId
        },
      });
      return undefined;
    }

    const rawSessionId = this.dependencies.rawSessionLocator.locate(event);
    if (!rawSessionId) {
      this.logEventDropped({ event, reason: 'missing_raw_session_id' });
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

    const headRun = this.dependencies.activeRunRegistry.getHeadByHostSession(resolution.hostSessionId);
    const activeRun = headRun?.hasPromptStarted() ? headRun : undefined;
    const factSessionContext = this.buildFactSessionContext(resolution, activeRun);
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
      activeRun,
      factSessionContext,
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
    this.dependencies.logger.debug?.('provider_adapter.event.received', routingState.eventRouteSummary);
  }

  private logEventDropped(input: {
    event: BridgeEvent;
    reason: EventDropReason;
    routeSummary?: Record<string, unknown>;
  }): void {
    this.dependencies.logger.debug?.('provider_adapter.event.dropped', {
      ...(input.routeSummary ?? { eventType: input.event.type }),
      dropReason: input.reason,
    });
  }

  private tryRouteToActiveRun(routingState: EventRoutingState): boolean {
    if (!routingState.activeRun) {
      this.logEventDropped({
        event: routingState.event,
        reason: 'missing_active_run',
        routeSummary: routingState.eventRouteSummary,
      });
      return false;
    }
    if (!this.canRouteToActiveRun(routingState.eventClass)) {
      this.logEventDropped({
        event: routingState.event,
        reason: 'unsupported_event',
        routeSummary: routingState.eventRouteSummary,
      });
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
      routingState.activeRun.runId,
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
    runId: string,
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
            source: 'active_run',
            tokenId: questionId,
            toolSessionId: factSessionContext.anchorSessionId,
            hostSessionId,
            runId,
          });
        }
      }
      if (fact.type === 'permission.ask') {
        const permissionId = (fact as { permissionId?: unknown }).permissionId;
        if (typeof permissionId === 'string' && permissionId.trim().length > 0) {
          recorder.record({
            kind: 'permission',
            source: 'active_run',
            tokenId: permissionId,
            toolSessionId: factSessionContext.anchorSessionId,
            hostSessionId,
            runId,
          });
        }
      }
    }
  }
}
