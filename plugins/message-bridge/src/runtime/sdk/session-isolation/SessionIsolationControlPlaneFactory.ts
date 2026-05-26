import type {
  OpencodeSessionOwnershipResolver,
  ToolSessionBindingStore,
  HostSessionQueryPort,
} from '../../../port/SlashCommandControlPlanePort.js';
import type { SessionCreationPort } from '../../../port/SessionCreationPort.js';
import type { SessionScopedActionGatewayPort } from '../../../port/SessionScopedActionGatewayPort.js';
import {
  InMemoryOwnedSessionRepository,
  LegacyAnchorBindingRepository,
  LegacyAttachOwnerRepository,
} from '../../../adapter/session-isolation/repository/index.js';
import { LegacyHostSessionGatewayAdapter } from '../../../adapter/session-isolation/host/index.js';
import { DefaultEntryKeyCodec } from '../../../domain/session-isolation/index.js';
import {
  DefaultAbortAnchoredRunUseCase,
  DefaultChatCommandUseCase,
  DefaultCloseOwnedSessionUseCase,
  DefaultCreateOwnedSessionUseCase,
  DefaultCreateSessionCommandUseCase,
  DefaultHostEventUseCase,
  DefaultOwnedSessionCoordinator,
  DefaultPermissionReplyCommandUseCase,
  DefaultQuestionReplyCommandUseCase,
  DefaultResolveEntrySessionContextUseCase,
  DefaultSessionDeletedReconcileUseCase,
  DefaultSwitchAttachedSessionUseCase,
  type BusinessEntryKeyResolver,
} from '../../../usecase/session-isolation/index.js';
import {
  PendingInteractionLookupBridge,
  SessionScopedSdkExecutionBridge,
} from '../../../adapter/session-isolation/runtime/index.js';
import {
  DefaultEventOwnershipResolver,
  DefaultEventSessionLocator,
  DefaultSessionDeletedEventHandler,
} from '../../../adapter/session-isolation/event/index.js';
import type {
  OwnedHostEventForwarder,
  OwnedSessionRepository,
} from '../../../port/session-isolation/outbound/index.js';
import type { RuntimePendingInteractionRegistry } from './RuntimePendingInteractionRegistry.js';
import type { RuntimeAnchorRepository } from '../../../usecase/session-isolation/CreateSessionCommandUseCase.js';

type LegacyQuestionListPort = {
  listQuestions(): Promise<unknown[]>;
};

export interface SessionIsolationControlPlaneDependencies {
  akScopeKey: string;
  bindingStore: ToolSessionBindingStore;
  ownershipResolver: OpencodeSessionOwnershipResolver;
  businessEntryKeyResolver: BusinessEntryKeyResolver;
  hostSessionQueryPort: HostSessionQueryPort;
  sessionCreationPort: SessionCreationPort;
  sessionScopedActionGatewayPort: SessionScopedActionGatewayPort;
  pendingInteractionRegistry: RuntimePendingInteractionRegistry;
  ownedHostEventForwarder: OwnedHostEventForwarder;
  ownedSessionRepository?: OwnedSessionRepository;
  runtimeAnchorRepository?: RuntimeAnchorRepository;
  toolSessionIdFactory?: () => string;
  legacyQuestionListPort?: LegacyQuestionListPort;
}

export interface SessionIsolationControlPlane {
  chatCommandPort: DefaultChatCommandUseCase;
  createSessionCommandPort: DefaultCreateSessionCommandUseCase;
  createOwnedSessionUseCase: DefaultCreateOwnedSessionUseCase;
  closeSessionCommandPort: DefaultCloseOwnedSessionUseCase;
  abortSessionCommandPort: DefaultAbortAnchoredRunUseCase;
  questionReplyCommandPort: DefaultQuestionReplyCommandUseCase;
  permissionReplyCommandPort: DefaultPermissionReplyCommandUseCase;
  hostEventPort: DefaultHostEventUseCase;
  resolveEntrySessionContextUseCase: DefaultResolveEntrySessionContextUseCase;
  switchAttachedSessionUseCase: DefaultSwitchAttachedSessionUseCase;
}

/**
 * 装配正式 session-isolation 控制面对象图。
 * @remarks 这是 runtime 迁移的单一装配入口，避免在 `BridgeRuntime` 中继续散落 repository/usecase wiring。
 */
export function createSessionIsolationControlPlane(
  dependencies: SessionIsolationControlPlaneDependencies,
): SessionIsolationControlPlane {
  const entryKeyCodec = new DefaultEntryKeyCodec();
  const ownedSessionRepository = dependencies.ownedSessionRepository ?? new InMemoryOwnedSessionRepository();
  const anchorBindingRepository = new LegacyAnchorBindingRepository(dependencies.bindingStore);
  const attachOwnerRepository = new LegacyAttachOwnerRepository(dependencies.ownershipResolver);
  const hostSessionGateway = new LegacyHostSessionGatewayAdapter({
    hostSessionQueryPort: dependencies.hostSessionQueryPort,
    sessionCreationPort: dependencies.sessionCreationPort,
    sessionScopedActionGatewayPort: dependencies.sessionScopedActionGatewayPort,
  });
  const ownedSessionCoordinator = new DefaultOwnedSessionCoordinator({
    akScopeKey: dependencies.akScopeKey,
    entryKeyCodec,
    ownedSessionRepository,
    anchorBindingRepository,
    attachOwnerRepository,
  });
  const resolveEntrySessionContextUseCase = new DefaultResolveEntrySessionContextUseCase({
    akScopeKey: dependencies.akScopeKey,
    entryKeyCodec,
    ownedSessionRepository,
    anchorBindingRepository,
    hostSessionGateway,
  });
  const switchAttachedSessionUseCase = new DefaultSwitchAttachedSessionUseCase({
    ownedSessionCoordinator,
  });
  const createOwnedSessionUseCase = new DefaultCreateOwnedSessionUseCase({
    hostSessionGateway,
    ownedSessionCoordinator,
  });
  const createSessionCommandPort = new DefaultCreateSessionCommandUseCase({
    businessEntryKeyResolver: dependencies.businessEntryKeyResolver,
    hostSessionGateway,
    ownedSessionCoordinator,
    ...(dependencies.runtimeAnchorRepository ? { runtimeAnchorRepository: dependencies.runtimeAnchorRepository } : {}),
    ...(dependencies.toolSessionIdFactory ? { toolSessionIdFactory: dependencies.toolSessionIdFactory } : {}),
  });
  const closeSessionCommandPort = new DefaultCloseOwnedSessionUseCase({
    anchorBindingRepository,
    hostSessionGateway,
    ownedSessionCoordinator,
    ...(dependencies.runtimeAnchorRepository ? { runtimeAnchorRepository: dependencies.runtimeAnchorRepository } : {}),
  });
  const sdkExecutionBridge = new SessionScopedSdkExecutionBridge({
    anchorBindingRepository,
    gatewayPort: dependencies.sessionScopedActionGatewayPort,
  });
  const abortSessionCommandPort = new DefaultAbortAnchoredRunUseCase({
    sdkExecutionBridge,
  });
  const interactionLookupBridge = new PendingInteractionLookupBridge({
    pendingInteractionRegistry: dependencies.pendingInteractionRegistry,
    anchorBindingRepository,
    ...(dependencies.legacyQuestionListPort
      ? { legacyQuestionListPort: dependencies.legacyQuestionListPort }
      : {}),
  });
  const questionReplyCommandPort = new DefaultQuestionReplyCommandUseCase({
    interactionLookupBridge,
    sdkExecutionBridge,
  });
  const permissionReplyCommandPort = new DefaultPermissionReplyCommandUseCase({
    interactionLookupBridge,
    sdkExecutionBridge,
  });
  const hostEventPort = new DefaultHostEventUseCase({
    eventSessionLocator: new DefaultEventSessionLocator(),
    eventOwnershipResolver: new DefaultEventOwnershipResolver({
      attachOwnerRepository,
    }),
    ownedHostEventForwarder: dependencies.ownedHostEventForwarder,
    sessionDeletedEventHandler: new DefaultSessionDeletedEventHandler(),
    sessionDeletedReconcileUseCase: new DefaultSessionDeletedReconcileUseCase({
      ownedSessionCoordinator,
    }),
  });

  return {
    chatCommandPort: new DefaultChatCommandUseCase({
      businessEntryKeyResolver: dependencies.businessEntryKeyResolver,
      resolveEntrySessionContextUseCase,
      switchAttachedSessionUseCase,
      createOwnedSessionUseCase,
      hostSessionGateway,
    }),
    createSessionCommandPort,
    createOwnedSessionUseCase,
    closeSessionCommandPort,
    abortSessionCommandPort,
    questionReplyCommandPort,
    permissionReplyCommandPort,
    hostEventPort,
    resolveEntrySessionContextUseCase,
    switchAttachedSessionUseCase,
  };
}
