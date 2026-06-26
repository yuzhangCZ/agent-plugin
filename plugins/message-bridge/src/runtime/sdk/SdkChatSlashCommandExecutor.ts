import type {
  HostModelCatalogPort,
  SessionModelOverrideStore,
  SlashCommand,
  SlashCommandFailure,
  SlashCommandResult,
} from '../../port/SlashCommandControlPlanePort.js';
import type { HostSessionRecord } from '../../port/session-isolation/dto/records/index.js';
import type { ResolvedEntrySessionContext } from '../../port/session-isolation/dto/results/index.js';
import type { CreateOwnedSessionRequest } from '../../usecase/session-isolation/CreateOwnedSessionUseCase.js';
import type { RuntimeAnchorRepository } from '../../usecase/session-isolation/CreateSessionCommandUseCase.js';
import type { BridgeLogger } from '../AppLogger.js';
import type { BusinessEntryContext } from './session-isolation/BusinessEntryContextResolver.js';
import type { ChatActionContext } from './SdkChatControlPlane.js';
import { buildTuiSessionListQuery } from './session-isolation/TuiSessionListQuery.js';

type ResolveEntrySessionContextUseCase = {
  execute(input: {
    toolSessionId: string;
    entryKey: BusinessEntryContext['entryKey'];
    policy: BusinessEntryContext['policy'];
    directory?: string;
    roots?: boolean;
    start?: number;
  }): Promise<ResolvedEntrySessionContext>;
};

type SwitchAttachedSessionUseCase = {
  execute(input: { toolSessionId: string; sessionId: string }): Promise<{ applied: true }>;
};

type CreateOwnedSessionUseCase = {
  execute(input: CreateOwnedSessionRequest): Promise<{ session: HostSessionRecord }>;
};

export interface SdkChatSlashCommandExecutorDependencies {
  resolveEntrySessionContextUseCase: ResolveEntrySessionContextUseCase;
  switchAttachedSessionUseCase: SwitchAttachedSessionUseCase;
  createOwnedSessionUseCase: CreateOwnedSessionUseCase;
  runtimeAnchorRepository: RuntimeAnchorRepository;
  modelOverrideStore: SessionModelOverrideStore;
  hostModelCatalogPort: HostModelCatalogPort;
  logger?: BridgeLogger;
}

/**
 * SDK chat bridge-local slash command 执行器。
 * @remarks 只承接已经完成 chat context / business entry 解析后的本地 slash command。
 * 不处理 OpenCode native command，也不负责 synthetic run 或 presenter。
 */
export class SdkChatSlashCommandExecutor {
  constructor(private readonly dependencies: SdkChatSlashCommandExecutorDependencies) {}

  async execute(input: {
    command: SlashCommand;
    context: ChatActionContext;
  }): Promise<SlashCommandResult> {
    switch (input.command.kind) {
      case 'new':
        return this.executeNew(input);
      case 'sessions':
        return this.executeSessions(input);
      case 'session':
        return this.executeSession({ ...input, command: input.command });
      case 'models':
        return this.executeModels();
      case 'model':
        return this.executeModel({ ...input, command: input.command });
      default:
        throw this.asFailure('invalid_command');
    }
  }

  private async executeNew(input: {
    context: ChatActionContext;
  }): Promise<Extract<SlashCommandResult, { kind: 'new' }>> {
    const directory = input.context.effectiveDirectory;
    const created = await this.dependencies.createOwnedSessionUseCase.execute({
      toolSessionId: input.context.anchor,
      entryKey: input.context.entryContext.entryKey,
      policy: input.context.entryContext.policy,
      ...(input.context.message.assistantId ? { assistantId: input.context.message.assistantId } : {}),
      ...(directory ? { directory } : {}),
    });
    await this.clearAnchorOnly(input.context.anchor);
    this.dependencies.logger?.info('session_isolation.slash.new.created', {
      anchor: input.context.anchor,
      entryKey: input.context.entryContext.policy.entryKey,
      createdSessionId: created.session.id,
      directory,
    });
    return {
      kind: 'new',
      previousSessionId: input.context.sessionContext.opencodeSessionId,
      session: created.session,
    };
  }

  private async executeSessions(input: {
    context: ChatActionContext;
  }): Promise<Extract<SlashCommandResult, { kind: 'sessions' }>> {
    const context = await this.resolveVisibleContext(input);
    this.dependencies.logger?.info('session_isolation.slash.sessions.resolved', {
      anchor: input.context.anchor,
      activeSessionId: input.context.sessionContext.opencodeSessionId,
      visibleSessionIds: context.visibleSessions.map((session) => session.id),
      visibleSessionCount: context.visibleSessions.length,
      directory: input.context.effectiveDirectory,
    });
    return {
      kind: 'sessions',
      sessions: context.visibleSessions,
      activeSessionId: input.context.sessionContext.opencodeSessionId,
    };
  }

  private async executeSession(input: {
    command: Extract<SlashCommand, { kind: 'session' }>;
    context: ChatActionContext;
  }): Promise<Extract<SlashCommandResult, { kind: 'session' }>> {
    const context = await this.resolveVisibleContext(input);
    const target = context.visibleSessions.find((session) => session.id === input.command.sessionId);
    if (!target) {
      throw this.asFailure('session_out_of_scope');
    }
    await this.dependencies.switchAttachedSessionUseCase.execute({
      toolSessionId: input.context.anchor,
      sessionId: target.id,
    });
    await this.clearAnchorOnly(input.context.anchor);
    return {
      kind: 'session',
      session: target,
      previousSessionId: input.context.sessionContext.opencodeSessionId,
    };
  }

  private async executeModels(): Promise<Extract<SlashCommandResult, { kind: 'models' }>> {
    const models = await this.dependencies.hostModelCatalogPort.listModels();
    return { kind: 'models', models };
  }

  private async executeModel(input: {
    command: Extract<SlashCommand, { kind: 'model' }>;
    context: ChatActionContext;
  }): Promise<Extract<SlashCommandResult, { kind: 'model' }>> {
    const models = await this.dependencies.hostModelCatalogPort.listModels();
    const exists = models.some((item) => item.providerId === input.command.providerId && item.modelId === input.command.modelId);
    if (!exists) {
      throw this.asFailure('model_not_found');
    }
    const override = {
      providerId: input.command.providerId,
      modelId: input.command.modelId,
    };
    this.dependencies.modelOverrideStore.set(input.context.sessionContext.opencodeSessionId, override);
    return {
      kind: 'model',
      sessionId: input.context.sessionContext.opencodeSessionId,
      modelOverride: override,
    };
  }

  private resolveVisibleContext(input: {
    context: ChatActionContext;
  }): Promise<ResolvedEntrySessionContext> {
    return this.dependencies.resolveEntrySessionContextUseCase.execute({
      toolSessionId: input.context.anchor,
      entryKey: input.context.entryContext.entryKey,
      policy: input.context.entryContext.policy,
      ...buildTuiSessionListQuery(input.context.effectiveDirectory),
    });
  }

  private async clearAnchorOnly(toolSessionId: string): Promise<void> {
    if (await this.dependencies.runtimeAnchorRepository.isAnchorOnly(toolSessionId)) {
      await this.dependencies.runtimeAnchorRepository.delete(toolSessionId);
    }
  }

  private asFailure(code: SlashCommandFailure['code']): SlashCommandFailure {
    return { code };
  }
}
