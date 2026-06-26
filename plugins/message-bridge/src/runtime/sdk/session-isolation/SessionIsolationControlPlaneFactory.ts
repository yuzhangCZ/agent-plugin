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
  SessionIsolationDiagnosticsPort,
  OwnedHostEventForwarder,
  OwnedSessionRepository,
} from '../../../port/session-isolation/outbound/index.js';
import type { RuntimePendingInteractionRegistry } from './RuntimePendingInteractionRegistry.js';
import type { RuntimeAnchorRepository } from '../../../usecase/session-isolation/CreateSessionCommandUseCase.js';
import type { BridgeLogger } from '../../AppLogger.js';

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
  diagnostics?: SessionIsolationDiagnosticsPort;
  runtimeAnchorRepository?: RuntimeAnchorRepository;
  toolSessionIdFactory?: () => string;
  logger?: BridgeLogger;
}

export interface SessionIsolationControlPlane {
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

type SessionIsolationRepositories = {
  entryKeyCodec: DefaultEntryKeyCodec;
  ownedSessionRepository: OwnedSessionRepository;
  anchorBindingRepository: LegacyAnchorBindingRepository;
  attachOwnerRepository: LegacyAttachOwnerRepository;
};

function createSessionIsolationRepositories(
  dependencies: SessionIsolationControlPlaneDependencies,
): SessionIsolationRepositories {
  return {
    entryKeyCodec: new DefaultEntryKeyCodec(),
    ownedSessionRepository: dependencies.ownedSessionRepository ?? new InMemoryOwnedSessionRepository(),
    anchorBindingRepository: new LegacyAnchorBindingRepository(dependencies.bindingStore),
    attachOwnerRepository: new LegacyAttachOwnerRepository(dependencies.ownershipResolver),
  };
}

function createHostSessionGateway(dependencies: SessionIsolationControlPlaneDependencies): LegacyHostSessionGatewayAdapter {
  return new LegacyHostSessionGatewayAdapter({
    hostSessionQueryPort: dependencies.hostSessionQueryPort,
    sessionCreationPort: dependencies.sessionCreationPort,
    sessionScopedActionGatewayPort: dependencies.sessionScopedActionGatewayPort,
  });
}

function createOwnedSessionCoordinator(
  dependencies: SessionIsolationControlPlaneDependencies,
  repositories: SessionIsolationRepositories,
): DefaultOwnedSessionCoordinator {
  return new DefaultOwnedSessionCoordinator({
    akScopeKey: dependencies.akScopeKey,
    entryKeyCodec: repositories.entryKeyCodec,
    ownedSessionRepository: repositories.ownedSessionRepository,
    anchorBindingRepository: repositories.anchorBindingRepository,
    attachOwnerRepository: repositories.attachOwnerRepository,
    ...(dependencies.diagnostics ? { diagnostics: dependencies.diagnostics } : {}),
    ...(dependencies.logger ? { logger: dependencies.logger } : {}),
  });
}

function createReplyCommandPorts(input: {
  pendingInteractionRegistry: RuntimePendingInteractionRegistry;
  anchorBindingRepository: LegacyAnchorBindingRepository;
  sdkExecutionBridge: SessionScopedSdkExecutionBridge;
}) {
  const interactionLookupBridge = new PendingInteractionLookupBridge({
    pendingInteractionRegistry: input.pendingInteractionRegistry,
    anchorBindingRepository: input.anchorBindingRepository,
  });
  return {
    questionReplyCommandPort: new DefaultQuestionReplyCommandUseCase({
      interactionLookupBridge,
      sdkExecutionBridge: input.sdkExecutionBridge,
    }),
    permissionReplyCommandPort: new DefaultPermissionReplyCommandUseCase({
      interactionLookupBridge,
      sdkExecutionBridge: input.sdkExecutionBridge,
    }),
  };
}

function createHostEventPort(input: {
  attachOwnerRepository: LegacyAttachOwnerRepository;
  ownedHostEventForwarder: OwnedHostEventForwarder;
  ownedSessionCoordinator: DefaultOwnedSessionCoordinator;
}): DefaultHostEventUseCase {
  return new DefaultHostEventUseCase({
    eventSessionLocator: new DefaultEventSessionLocator(),
    eventOwnershipResolver: new DefaultEventOwnershipResolver({
      attachOwnerRepository: input.attachOwnerRepository,
    }),
    ownedHostEventForwarder: input.ownedHostEventForwarder,
    sessionDeletedEventHandler: new DefaultSessionDeletedEventHandler(),
    sessionDeletedReconcileUseCase: new DefaultSessionDeletedReconcileUseCase({
      ownedSessionCoordinator: input.ownedSessionCoordinator,
    }),
  });
}

/**
 * 装配正式 session-isolation 控制面对象图。
 * @remarks 这是 runtime 迁移的单一装配入口，避免 repository/usecase wiring 散落在插件主链。
 */
export function createSessionIsolationControlPlane(
  dependencies: SessionIsolationControlPlaneDependencies,
): SessionIsolationControlPlane {
  const repositories = createSessionIsolationRepositories(dependencies);
  const {
    entryKeyCodec,
    ownedSessionRepository,
    anchorBindingRepository,
    attachOwnerRepository,
  } = repositories;
  const hostSessionGateway = createHostSessionGateway(dependencies);
  const ownedSessionCoordinator = createOwnedSessionCoordinator(dependencies, repositories);
  const resolveEntrySessionContextUseCase = new DefaultResolveEntrySessionContextUseCase({
    akScopeKey: dependencies.akScopeKey,
    entryKeyCodec,
    ownedSessionRepository,
    anchorBindingRepository,
    hostSessionGateway,
    ...(dependencies.logger ? { logger: dependencies.logger } : {}),
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
  const {
    questionReplyCommandPort,
    permissionReplyCommandPort,
  } = createReplyCommandPorts({
    pendingInteractionRegistry: dependencies.pendingInteractionRegistry,
    anchorBindingRepository,
    sdkExecutionBridge,
  });
  const hostEventPort = createHostEventPort({
    attachOwnerRepository,
    ownedHostEventForwarder: dependencies.ownedHostEventForwarder,
    ownedSessionCoordinator,
  });

  return {
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
