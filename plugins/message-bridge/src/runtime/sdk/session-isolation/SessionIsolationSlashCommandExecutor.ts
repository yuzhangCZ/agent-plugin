import type {
  HostSessionCreateContext,
  SlashCommand,
  SlashCommandResult,
} from '../../../port/SlashCommandControlPlanePort.js';
import type { HostSessionRecord } from '../../../port/session-isolation/dto/records/index.js';
import type { ResolvedEntrySessionContext } from '../../../port/session-isolation/dto/results/index.js';
import type { CreateOwnedSessionRequest } from '../../../usecase/session-isolation/CreateOwnedSessionUseCase.js';
import type { RuntimeAnchorRepository } from '../../../usecase/session-isolation/CreateSessionCommandUseCase.js';
import type { BusinessEntryContext } from './BusinessEntryContextResolver.js';

type ResolveEntrySessionContextUseCase = {
  execute(input: {
    toolSessionId: string;
    entryKey: BusinessEntryContext['entryKey'];
    policy: BusinessEntryContext['policy'];
    directory?: string;
  }): Promise<ResolvedEntrySessionContext>;
};

type SwitchAttachedSessionUseCase = {
  execute(input: { toolSessionId: string; sessionId: string }): Promise<{ applied: true }>;
};

type CreateOwnedSessionUseCase = {
  execute(input: CreateOwnedSessionRequest): Promise<{ session: HostSessionRecord }>;
};

/**
 * SDK runtime 中面向 session-isolation 控制面的 slash 命令执行器。
 * @remarks 只承接 `/new`、`/sessions`、`/session` 这类会话控制命令；模型命令仍留在 legacy executor。
 */
export class SessionIsolationSlashCommandExecutor {
  constructor(private readonly dependencies: {
    resolveEntrySessionContextUseCase: ResolveEntrySessionContextUseCase;
    switchAttachedSessionUseCase: SwitchAttachedSessionUseCase;
    createOwnedSessionUseCase: CreateOwnedSessionUseCase;
    runtimeAnchorRepository: RuntimeAnchorRepository;
  }) {}

  async execute(input: {
    command: SlashCommand;
    anchor: string;
    entryContext: BusinessEntryContext;
    createContext?: HostSessionCreateContext;
    directory?: string;
  }): Promise<SlashCommandResult> {
    switch (input.command.kind) {
      case 'new':
        return this.executeNew(input);
      case 'sessions':
        return this.executeSessions(input);
      case 'session':
        return this.executeSession({
          ...input,
          command: input.command,
        });
      default:
        throw { code: 'invalid_command' };
    }
  }

  private async executeNew(input: {
    anchor: string;
    entryContext: BusinessEntryContext;
    createContext?: HostSessionCreateContext;
    directory?: string;
  }): Promise<Extract<SlashCommandResult, { kind: 'new' }>> {
    const created = await this.dependencies.createOwnedSessionUseCase.execute({
      toolSessionId: input.anchor,
      entryKey: input.entryContext.entryKey,
      policy: input.entryContext.policy,
      ...(input.createContext?.assistantId ? { assistantId: input.createContext.assistantId } : {}),
      ...(input.directory ? { directory: input.directory } : {}),
    });
    await this.clearAnchorOnly(input.anchor);
    return {
      kind: 'new',
      session: created.session,
    };
  }

  private async executeSessions(input: {
    anchor: string;
    entryContext: BusinessEntryContext;
    directory?: string;
  }): Promise<Extract<SlashCommandResult, { kind: 'sessions' }>> {
    const context = await this.resolveVisibleContext(input);
    return {
      kind: 'sessions',
      sessions: context.visibleSessions,
      ...(context.session ? { activeSessionId: context.session.id } : {}),
    };
  }

  private async executeSession(input: {
    command: Extract<SlashCommand, { kind: 'session' }>;
    anchor: string;
    entryContext: BusinessEntryContext;
    directory?: string;
  }): Promise<Extract<SlashCommandResult, { kind: 'session' }>> {
    const context = await this.resolveVisibleContext(input);
    const target = context.visibleSessions.find((session) => session.id === input.command.sessionId);
    if (!target) {
      throw { code: 'session_out_of_scope' };
    }
    await this.dependencies.switchAttachedSessionUseCase.execute({
      toolSessionId: input.anchor,
      sessionId: target.id,
    });
    await this.clearAnchorOnly(input.anchor);
    return {
      kind: 'session',
      session: target,
      ...(context.session ? { previousSessionId: context.session.id } : {}),
    };
  }

  private resolveVisibleContext(input: {
    anchor: string;
    entryContext: BusinessEntryContext;
    directory?: string;
  }): Promise<ResolvedEntrySessionContext> {
    return this.dependencies.resolveEntrySessionContextUseCase.execute({
      toolSessionId: input.anchor,
      entryKey: input.entryContext.entryKey,
      policy: input.entryContext.policy,
      ...(input.directory ? { directory: input.directory } : {}),
    });
  }

  private async clearAnchorOnly(toolSessionId: string): Promise<void> {
    if (await this.dependencies.runtimeAnchorRepository.isAnchorOnly(toolSessionId)) {
      await this.dependencies.runtimeAnchorRepository.delete(toolSessionId);
    }
  }
}
