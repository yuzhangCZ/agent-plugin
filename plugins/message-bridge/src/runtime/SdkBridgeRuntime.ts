import { randomUUID } from 'node:crypto';

import {
  InMemoryOpencodeSessionOwnershipResolver,
  InMemorySessionModelOverrideStore,
  InMemoryToolSessionBindingStore,
  OpencodeSessionGatewayAdapter,
  SimpleSlashCommandParser,
} from '../adapter/index.js';
import {
  CreateSessionRequestNormalizer,
  CreateSessionUseCase,
  DefaultSlashCommandReplyPresenter,
  SlashCommandExecutor,
} from '../usecase/index.js';
import { SubagentSessionMapper } from '../session/SubagentSessionMapper.js';
import type {
  HostModelCatalogPort,
  HostSessionCreationPort,
  HostSessionListQuery,
  HostSessionQueryPort,
} from '../port/SlashCommandControlPlanePort.js';
import {
  createBridgeRuntime,
  type BridgeRuntime as SdkRuntimeFacade,
} from '@wecode/bridge-runtime-sdk';
import { loadConfig } from '../config/index.js';
import { EventFilter } from '../event/EventFilter.js';
import { createSdkAdapter, getMissingSdkCapabilities, toHostClientLike } from './SdkAdapter.js';
import { AppLogger, type BridgeLogger } from './AppLogger.js';
import { createSdkRuntimeStatusAdapter, type SdkRuntimeStatusAdapter } from './SdkRuntimeStatusAdapter.js';
import { readMessageBridgeStatusSnapshot, resetMessageBridgeStatus } from './MessageBridgeStatusStore.js';
import { resolvePluginVersion } from './pluginVersion.js';
import { resolveRegisterMetadata } from './RegisterMetadata.js';
import { isBridgeStartupError, validateBridgeStartup } from './Startup.js';
import type { ManagedRuntime, ManagedRuntimeStartOptions } from './ManagedRuntime.js';
import type { BridgeEvent } from './types.js';
import { OpenCodeProviderAdapter } from './sdk/OpenCodeProviderAdapter.js';
import {
  ChatEntryPolicy,
  DefaultChatExecutionContextResolver,
  DefaultCreatedSessionBindingPort,
  DefaultEventAnchorResolver,
  DefaultExecutionSessionInvalidationPort,
  SdkChatPreprocessor,
  SdkSlashExecutionUseCase,
  StaticSlashCapabilityProvider,
} from './sdk/SdkChatControlPlane.js';
import {
  DefaultBusinessEntryKeyResolver,
  DefaultBusinessEntryPolicyResolver,
  BusinessEntryContextResolver,
  EntryAwareChatSessionResolver,
  RuntimeAnchorRegistry,
  RuntimePendingInteractionRegistry,
  SessionIsolationDiagnostics,
  createSessionIsolationControlPlane,
} from './sdk/session-isolation/index.js';
import {
  AkScopedEntrySessionStorePathResolver,
  FileOwnedSessionRepository,
} from '../adapter/session-isolation/repository/index.js';
import { getErrorDetailsForLog, getErrorMessage, getToolErrorEvidence } from '../utils/error.js';
import { asRecord, asTrimmedString } from '../utils/type-guards.js';
import type { BridgeSdkClient } from '../types/sdk.js';

const MESSAGE_BRIDGE_RUNTIME_DISABLED = 'message_bridge_runtime_disabled';
const SDK_RUNTIME_MODE = 'sdk';

function isRuntimeStartAbortedError(error: unknown): boolean {
  return error instanceof Error && error.message === 'runtime_start_aborted';
}

/**
 * SDK-backed runtime。
 * @remarks
 * 下行命令和正式 uplink 主链交给 `bridge-runtime-sdk`，插件只保留宿主策略、
 * raw event -> fact 翻译。
 */
export class SdkBridgeRuntime implements ManagedRuntime {
  private readonly workspacePath?: string;
  private readonly rawClient;
  private readonly sdkClient;
  private readonly missingSdkCapabilities;
  private logger: BridgeLogger;
  private readonly statusAdapter: SdkRuntimeStatusAdapter;
  private readonly sessionIsolationDataDir?: string;

  private eventFilter: EventFilter | null = null;
  private started = false;
  private effectiveDirectory?: string;
  private sdkRuntime: SdkRuntimeFacade | null = null;
  private providerAdapter: OpenCodeProviderAdapter | null = null;

  constructor(options: {
    workspacePath?: string;
    hostDirectory?: string;
    client: unknown;
    runtimeTraceId?: string;
    sessionIsolationDataDir?: string;
  }) {
    this.workspacePath = options.workspacePath;
    this.rawClient = toHostClientLike(options.client);
    this.sdkClient = createSdkAdapter(options.client);
    this.missingSdkCapabilities = getMissingSdkCapabilities(options.client);
    this.logger = this.createRuntimeLogger({ traceId: options.runtimeTraceId });
    this.statusAdapter = createSdkRuntimeStatusAdapter();
    this.sessionIsolationDataDir = options.sessionIsolationDataDir;
  }

  async start(options: ManagedRuntimeStartOptions = {}): Promise<void> {
    const pluginVersion = resolvePluginVersion();
    this.logger.info('runtime.start.requested', {
      workspacePath: this.workspacePath,
      pluginVersion,
    });

    if (this.started) {
      return;
    }

    this.statusAdapter.publishConnecting();
    let config;
    try {
      config = await this.resolveConfig();
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      this.logger.error('runtime.config.loading_failed', {
        error: errorMessage,
        workspacePath: this.workspacePath,
      });
      this.statusAdapter.publishConfigInvalid(errorMessage);
      throw error;
    }
    if (!config.enabled) {
      const disabledError = new Error(MESSAGE_BRIDGE_RUNTIME_DISABLED);
      this.statusAdapter.publishDisabled(disabledError.message);
      throw disabledError;
    }

    this.logger = this.createRuntimeLogger({
      traceId: this.logger.getTraceId(),
      debug: !!config.debug,
    });
    this.effectiveDirectory = config.bridgeDirectory;
    this.eventFilter = new EventFilter(config.events.allowlist);

    let startupValidation;
    try {
      startupValidation = await validateBridgeStartup(this.rawClient, this.sdkClient, this.missingSdkCapabilities);
    } catch (error) {
      if (isBridgeStartupError(error)) {
        this.statusAdapter.publishPluginFailure(error.message);
      }
      throw error;
    }

    const registerMetadata = resolveRegisterMetadata(startupValidation.health.version, this.logger);
    const bindingStore = new InMemoryToolSessionBindingStore();
    const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
    const sessionModelOverrideStore = new InMemorySessionModelOverrideStore();
    const slashCommandParser = new SimpleSlashCommandParser();
    const opencodeSessionGatewayAdapter = new OpencodeSessionGatewayAdapter(() => startupValidation.sdkClient);
    const createSessionUseCase = new CreateSessionUseCase(opencodeSessionGatewayAdapter);
    const createSessionRequestNormalizer = new CreateSessionRequestNormalizer();
    const hostSessionCreationPort: HostSessionCreationPort = {
      createSession: async (input?: { assistantId?: string; imGroupId?: string }) => {
        const normalized = createSessionRequestNormalizer.fromChatContext({
          assistantId: input?.assistantId,
          imGroupId: input?.imGroupId,
        });
        const result = await createSessionUseCase.execute({
          ...normalized,
          directory: config.bridgeDirectory,
          ...(config.bridgeDirectory ? { directorySource: 'config' } : {}),
        });
        if (!result.success) {
          const error = new Error(result.errorMessage ?? 'create_session_failed');
          Object.assign(error, { errorEvidence: result.errorEvidence });
          throw error;
        }
        if (!result.data.sessionId) {
          throw new Error('create_session_missing_session_id');
        }
        const session = result.data.session ?? {};
        return {
          id: result.data.sessionId,
          title: typeof session.title === 'string' ? session.title : undefined,
          projectID: typeof session.projectID === 'string' ? session.projectID : undefined,
          workspaceID: typeof session.workspaceID === 'string' ? session.workspaceID : undefined,
          directory: typeof session.directory === 'string' ? session.directory : undefined,
        };
      },
    };
    const sessionCreationPort = {
      createSession: async (input: { title?: string; directory?: string }) => {
        const result = await createSessionUseCase.execute({
          title: input.title,
          isGroupChat: false,
          directory: input.directory ?? config.bridgeDirectory,
          ...(input.directory
            ? { directorySource: 'explicit' as const }
            : config.bridgeDirectory
              ? { directorySource: 'config' as const }
              : {}),
        });
        return result;
      },
    };
    const hostSessionQueryPort: HostSessionQueryPort = {
      getSession: async (sessionId: string) => {
        return this.getHostSessionInfo(startupValidation.sdkClient, sessionId);
      },
      listSessions: async (query: HostSessionListQuery) => {
        return this.listHostSessions(startupValidation.sdkClient, query);
      },
    };
    const hostModelCatalogPort: HostModelCatalogPort = {
      listModels: async () => this.listHostModels(startupValidation.sdkClient),
    };
    const businessEntryKeyResolver = new DefaultBusinessEntryKeyResolver();
    const businessEntryPolicyResolver = new DefaultBusinessEntryPolicyResolver();
    const businessEntryContextResolver = new BusinessEntryContextResolver({
      businessEntryKeyResolver,
      businessEntryPolicyResolver,
    });
    const sessionIsolationDiagnostics = new SessionIsolationDiagnostics({
      logger: this.logger.child({ component: 'session_isolation' }),
    });
    const runtimeAnchorRegistry = new RuntimeAnchorRegistry();
    const sessionIsolationStorePath = new AkScopedEntrySessionStorePathResolver({
      ...(this.sessionIsolationDataDir ? { dataDir: this.sessionIsolationDataDir } : {}),
    }).resolve({ authAk: config.auth.ak });
    this.logger.info('session_isolation.store.configured', {
      filePath: sessionIsolationStorePath,
      pathMode: 'unix_user_local_share',
      hasOverrideDataDir: Boolean(this.sessionIsolationDataDir),
    });
    const ownedSessionRepository = new FileOwnedSessionRepository({
      filePath: sessionIsolationStorePath,
      diagnostics: sessionIsolationDiagnostics,
    });
    const pendingInteractionRegistry = new RuntimePendingInteractionRegistry();
    const sessionIsolationControlPlane = createSessionIsolationControlPlane({
      akScopeKey: config.auth.ak,
      bindingStore,
      ownershipResolver,
      businessEntryKeyResolver,
      ownedSessionRepository,
      diagnostics: sessionIsolationDiagnostics,
      logger: this.logger.child({ component: 'session_isolation' }),
      hostSessionQueryPort,
      sessionCreationPort,
      sessionScopedActionGatewayPort: opencodeSessionGatewayAdapter,
      pendingInteractionRegistry,
      runtimeAnchorRepository: runtimeAnchorRegistry,
      toolSessionIdFactory: () => `ses_${randomUUID().replaceAll('-', '')}`,
      ownedHostEventForwarder: {
        forward: async () => ({ applied: true }),
      },
    });
    const contextResolver = new DefaultChatExecutionContextResolver({
      bindingStore,
      ownershipResolver,
      modelOverrideStore: sessionModelOverrideStore,
      hostSessionCreationPort,
      hostSessionQueryPort,
    });
    const slashCommandExecutor = new SlashCommandExecutor({
      bindingStore,
      ownershipResolver,
      modelOverrideStore: sessionModelOverrideStore,
      hostSessionCreationPort,
      hostSessionQueryPort,
      hostModelCatalogPort,
    });
    const chatPreprocessor = new SdkChatPreprocessor({
      chatEntryPolicy: new ChatEntryPolicy({
        slashCommandParser,
        slashCapabilityProvider: new StaticSlashCapabilityProvider(),
      }),
      slashExecutionUseCase: new SdkSlashExecutionUseCase({
        slashCommandExecutor,
        sessionIsolationSlashCommandExecutor: sessionIsolationControlPlane.slashCommandExecutor,
        replyPresenter: new DefaultSlashCommandReplyPresenter(),
        contextResolver,
      }),
      contextResolver,
      businessEntryContextResolver,
      effectiveDirectory: config.bridgeDirectory,
      normalChatSessionResolver: new EntryAwareChatSessionResolver({
        businessEntryKeyResolver,
        resolveEntrySessionContextUseCase: sessionIsolationControlPlane.resolveEntrySessionContextUseCase,
        switchAttachedSessionUseCase: sessionIsolationControlPlane.switchAttachedSessionUseCase,
        createOwnedSessionUseCase: sessionIsolationControlPlane.createOwnedSessionUseCase,
        runtimeAnchorRepository: runtimeAnchorRegistry,
        modelOverrideStore: sessionModelOverrideStore,
      }),
    });
    this.providerAdapter = new OpenCodeProviderAdapter({
      rawClient: this.rawClient,
      logger: this.logger.child({ component: 'provider_adapter' }),
      createSessionUseCase,
      createSessionCommandPort: sessionIsolationControlPlane.createSessionCommandPort,
      closeSessionCommandPort: sessionIsolationControlPlane.closeSessionCommandPort,
      abortSessionCommandPort: sessionIsolationControlPlane.abortSessionCommandPort,
      questionReplyCommandPort: sessionIsolationControlPlane.questionReplyCommandPort,
      permissionReplyCommandPort: sessionIsolationControlPlane.permissionReplyCommandPort,
      hostEventPort: sessionIsolationControlPlane.hostEventPort,
      pendingInteractionRecorder: pendingInteractionRegistry,
      effectiveDirectory: config.bridgeDirectory,
      opencodeSessionGatewayAdapter,
      chatPreprocessor,
      contextResolver,
      executionSessionInvalidationPort: new DefaultExecutionSessionInvalidationPort({
        bindingStore,
        ownershipResolver,
      }),
      eventAnchorResolver: new DefaultEventAnchorResolver({
        ownershipResolver,
      }),
      createdSessionBindingPort: new DefaultCreatedSessionBindingPort({
        bindingStore,
        ownershipResolver,
      }),
      subagentSessionMapper: new SubagentSessionMapper(() => startupValidation.sdkClient),
    });

    this.sdkRuntime = await createBridgeRuntime({
      provider: this.providerAdapter,
      gatewayHost: {
        url: config.gateway.url,
        auth: {
          ak: config.auth.ak,
          sk: config.auth.sk,
        },
        register: {
          channel: config.gateway.channel,
          toolVersion: registerMetadata.toolVersion,
          pluginVersion,
        },
      },
      debug: config.debug,
      traceIdFactory: () => randomUUID(),
      logger: this.logger,
      onTelemetryUpdated: () => this.syncSdkStatus(),
    });

    let abortListener: (() => void) | undefined;
    try {
      const startPromise = this.sdkRuntime.start();
      if (options.abortSignal) {
        const { abortSignal } = options;
        const abortPromise = new Promise<never>((_, reject) => {
          abortListener = () => {
            void this.sdkRuntime?.stop().catch(() => undefined);
            reject(new Error('runtime_start_aborted'));
          };
          if (abortSignal.aborted) {
            abortListener();
            return;
          }
          abortSignal.addEventListener('abort', abortListener, { once: true });
        });
        await Promise.race([startPromise, abortPromise]);
        if (abortSignal.aborted) {
          await startPromise.catch(() => undefined);
          throw new Error('runtime_start_aborted');
        }
      } else {
        await startPromise;
      }
      this.started = true;
      this.syncSdkStatus();
      this.logger.info('runtime.start.completed', {
        runtimeMode: SDK_RUNTIME_MODE,
        effectiveDirectory: this.effectiveDirectory,
      });
    } catch (error) {
      if (!isRuntimeStartAbortedError(error)) {
        this.statusAdapter.publishPluginFailure(getErrorMessage(error));
      }
      throw error;
    } finally {
      if (abortListener) {
        options.abortSignal?.removeEventListener('abort', abortListener);
      }
    }
  }

  stop(): void {
    this.sdkRuntime?.stop().catch((error) => {
      this.logger.error('runtime.stop.failed', {
        error: getErrorMessage(error),
        ...getErrorDetailsForLog(error),
      });
    });
    this.sdkRuntime = null;
    this.providerAdapter = null;
    this.started = false;
    resetMessageBridgeStatus();
    this.logger.info('runtime.stop.completed', { runtimeMode: SDK_RUNTIME_MODE });
  }

  async handleEvent(event: BridgeEvent): Promise<void> {
    if (!this.started || !this.eventFilter) {
      return;
    }

    const handledByProvider = await this.providerAdapter?.handleEvent(event);
    if (!handledByProvider && this.eventFilter.isAllowed(event.type)) {
      this.logger.debug('runtime.event.ignored', {
        eventType: event.type,
        reason: 'sdk_mainline_unhandled',
      });
    }
  }

  getStarted(): boolean {
    return this.started;
  }

  protected async resolveConfig() {
    return loadConfig(this.workspacePath, this.logger);
  }

  private createRuntimeLogger(input: { traceId?: string; debug?: boolean } = {}): BridgeLogger {
    return new AppLogger(
      this.rawClient,
      { component: 'sdk_runtime', runtimeMode: SDK_RUNTIME_MODE },
      input.traceId,
      undefined,
      input.debug,
    );
  }

  private async getHostSessionInfo(client: BridgeSdkClient, sessionId: string) {
    let payload: unknown;
    try {
      const result = await client.session.get({ sessionID: sessionId });
      payload = this.unwrapSdkData(result);
    } catch (error) {
      throw this.toSdkControlPlaneError(error, 'session.get');
    }
    const session = asRecord(payload);
    const resolvedId = asTrimmedString(session?.id);
    if (!resolvedId) {
      throw new Error(`control_plane.session_get_missing_id:${sessionId}`);
    }

    return {
      id: resolvedId,
      title: asTrimmedString(session?.title),
      projectID: asTrimmedString(session?.projectID),
      workspaceID: asTrimmedString(session?.workspaceID),
      directory: asTrimmedString(session?.directory),
    };
  }

  private async listHostSessions(
    client: BridgeSdkClient,
    query: HostSessionListQuery,
  ) {
    const result = await client.session.list({
      ...(query.directory ? { directory: query.directory } : {}),
      ...(query.roots !== undefined ? { roots: query.roots } : {}),
      ...(query.start !== undefined ? { start: query.start } : {}),
    });
    const payload = this.unwrapSdkData(result);
    if (!Array.isArray(payload)) {
      return [];
    }

    const sessions = [];
    for (const item of payload) {
      const session = asRecord(item);
      const id = asTrimmedString(session?.id);
      if (!id) {
        continue;
      }

      const projected = {
        id,
        ...(asTrimmedString(session?.title) ? { title: asTrimmedString(session?.title) } : {}),
        ...(asTrimmedString(session?.projectID) ? { projectID: asTrimmedString(session?.projectID) } : {}),
        ...(asTrimmedString(session?.workspaceID) ? { workspaceID: asTrimmedString(session?.workspaceID) } : {}),
        ...(asTrimmedString(session?.directory) ? { directory: asTrimmedString(session?.directory) } : {}),
      };
      sessions.push(projected);
    }
    return sessions;
  }

  private async listHostModels(client: BridgeSdkClient) {
    const providersResult = await client.config.providers();
    const payload = this.unwrapSdkData(providersResult);
    const providers = Array.isArray(payload)
      ? payload
      : Array.isArray(asRecord(payload)?.providers)
        ? (asRecord(payload)?.providers as unknown[])
        : [];

    return providers.flatMap((provider) => {
      const providerRecord = asRecord(provider);
      const providerId =
        asTrimmedString(providerRecord?.id)
        ?? asTrimmedString(providerRecord?.providerID)
        ?? asTrimmedString(providerRecord?.name);
      if (!providerId) {
        return [];
      }
      const modelCatalog = asRecord(providerRecord?.models);
      const models = modelCatalog ? Object.values(modelCatalog) : [];
      return models.flatMap((model) => {
        const modelRecord = asRecord(model);
        const modelId =
          asTrimmedString(modelRecord?.id)
          ?? asTrimmedString(modelRecord?.modelID)
          ?? asTrimmedString(modelRecord?.name);
        if (!modelId) {
          return [];
        }
        return [{
          providerId,
          modelId,
          label: asTrimmedString(modelRecord?.label),
        }];
      });
    });
  }

  private unwrapSdkData(result: unknown) {
    const record = asRecord(result);
    if (record?.error !== undefined) {
      throw record.error;
    }
    if ('data' in (record ?? {})) {
      return record?.data;
    }
    return result;
  }

  private toSdkControlPlaneError(error: unknown, sourceOperation: 'session.get') {
    return {
      errorCode: 'SDK_UNREACHABLE',
      errorMessage: 'Failed to send message',
      errorEvidence: getToolErrorEvidence(error, sourceOperation),
    };
  }

  private syncSdkStatus(): void {
    const status = this.sdkRuntime?.getStatus();
    if (!status) {
      return;
    }

    if (status.state === 'ready') {
      const publicStatus = readMessageBridgeStatusSnapshot();
      if (publicStatus.phase === 'ready' && publicStatus.connected) {
        return;
      }
      this.statusAdapter.publishGatewayState('READY');
      return;
    }

    if (status.state === 'starting' || status.state === 'reconnecting') {
      this.statusAdapter.publishGatewayState('CONNECTING');
      return;
    }

    if (status.state === 'failed' && status.failureReason) {
      this.statusAdapter.publishPluginFailure(status.failureReason);
    }
  }
}
