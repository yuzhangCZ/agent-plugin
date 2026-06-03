import type {
  HostModelCatalogPort,
  HostSessionCreateContext,
  HostSessionCreationPort,
  HostSessionListQuery,
  HostSessionQueryPort,
  OpencodeSessionOwnershipResolver,
  SessionModelOverrideStore,
  SlashCommand,
  SlashCommandContext,
  SlashCommandFailure,
  SlashCommandFailureCode,
  SlashCommandResult,
  ToolSessionBindingStore,
} from '../port/SlashCommandControlPlanePort.js';

const TUI_SESSION_LIST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * slash 命令执行器。
 * @remarks
 * 只负责控制面命令语义与状态副作用，不负责 completion 发送。
 */
export class SlashCommandExecutor {
  constructor(private readonly dependencies: {
    bindingStore: ToolSessionBindingStore;
    ownershipResolver: OpencodeSessionOwnershipResolver;
    modelOverrideStore: SessionModelOverrideStore;
    hostSessionCreationPort: HostSessionCreationPort;
    hostSessionQueryPort: HostSessionQueryPort;
    hostModelCatalogPort: HostModelCatalogPort;
  }) {}

  async execute(
    command: SlashCommand,
    context: SlashCommandContext,
    createContext?: HostSessionCreateContext,
  ): Promise<SlashCommandResult> {
    switch (command.kind) {
      case 'new': {
        const previousSessionId = context.activeOpencodeSessionId;
        const session = await this.dependencies.hostSessionCreationPort.createSession(createContext);
        this.rebind(context.anchor, previousSessionId, session.id);
        return { kind: 'new', session, previousSessionId };
      }
      case 'sessions': {
        const sessions = await this.dependencies.hostSessionQueryPort.listSessions(
          this.buildTuiVisibleSessionListQuery(context),
        );
        return {
          kind: 'sessions',
          sessions,
          activeSessionId: context.activeOpencodeSessionId,
        };
      }
      case 'session': {
        const sessions = await this.dependencies.hostSessionQueryPort.listSessions(
          this.buildTuiVisibleSessionListQuery(context),
        );
        const target = sessions.find((session) => session.id === command.sessionId);
        if (!target) {
          throw this.asFailure('session_out_of_scope');
        }
        this.rebind(context.anchor, context.activeOpencodeSessionId, target.id);
        return {
          kind: 'session',
          session: target,
          previousSessionId: context.activeOpencodeSessionId,
        };
      }
      case 'models': {
        const models = await this.dependencies.hostModelCatalogPort.listModels();
        return { kind: 'models', models };
      }
      case 'model': {
        const sessionId = context.activeOpencodeSessionId;
        if (!sessionId) {
          throw this.asFailure('session_not_found');
        }
        const models = await this.dependencies.hostModelCatalogPort.listModels();
        const exists = models.some((item) => item.providerId === command.providerId && item.modelId === command.modelId);
        if (!exists) {
          throw this.asFailure('model_not_found');
        }
        const override = {
          providerId: command.providerId,
          modelId: command.modelId,
        };
        this.dependencies.modelOverrideStore.set(sessionId, override);
        return {
          kind: 'model',
          sessionId,
          modelOverride: override,
        };
      }
      default:
        throw this.asFailure('invalid_command');
    }
  }

  normalizeFailure(error: unknown): SlashCommandFailure {
    const sourceErrorCode = this.extractSourceErrorCode(error);
    if (sourceErrorCode === 'session_not_found') {
      return { code: 'session_not_found' };
    }

    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && typeof (error as { code: unknown }).code === 'string'
    ) {
      const normalizedError = error as {
        code: string;
        reasonKey?: SlashCommandFailure['reasonKey'];
      };
      return {
        code: this.isSlashCommandFailureCode(normalizedError.code) ? normalizedError.code : 'sdk_unreachable',
        ...(typeof normalizedError.reasonKey === 'string' ? { reasonKey: normalizedError.reasonKey } : {}),
      };
    }

    return {
      code: 'sdk_unreachable',
    };
  }

  private rebind(anchor: string, previousSessionId: string | undefined, nextSessionId: string): void {
    if (previousSessionId && previousSessionId !== nextSessionId) {
      this.dependencies.ownershipResolver.detach(previousSessionId);
    }
    this.dependencies.bindingStore.bind(anchor, nextSessionId);
    this.dependencies.ownershipResolver.attach(nextSessionId, anchor);
  }

  private buildTuiVisibleSessionListQuery(context: SlashCommandContext): HostSessionListQuery {
    return {
      ...(context.scope?.directory ? { directory: context.scope.directory } : {}),
      roots: true,
      start: Date.now() - TUI_SESSION_LIST_WINDOW_MS,
    };
  }

  private asFailure(code: SlashCommandFailureCode): SlashCommandFailure {
    return { code };
  }

  private extractSourceErrorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null) {
      return undefined;
    }
    const evidence = (error as {
      errorEvidence?: { sourceErrorCode?: unknown };
    }).errorEvidence;
    return typeof evidence?.sourceErrorCode === 'string' ? evidence.sourceErrorCode : undefined;
  }

  private isSlashCommandFailureCode(code: string): code is SlashCommandFailureCode {
    return code === 'session_not_found'
      || code === 'session_out_of_scope'
      || code === 'model_not_found'
      || code === 'invalid_command'
      || code === 'command_disabled_in_group_chat'
      || code === 'sdk_unreachable';
  }
}
