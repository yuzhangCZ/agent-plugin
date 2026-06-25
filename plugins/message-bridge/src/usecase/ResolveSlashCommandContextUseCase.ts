import type {
  HostSessionCreationPort,
  HostSessionCreateContext,
  HostSessionQueryPort,
  SessionModelOverrideStore,
  SlashCommandContext,
  SlashCommandContextResolver,
  ToolSessionBindingStore,
  OpencodeSessionOwnershipResolver,
  ExternalConversationAnchor,
} from '../port/SlashCommandControlPlanePort.js';
import type { BridgeLogger } from '../types/logger.js';

/** 解析 slash/chat 共用的 binding 上下文，并在缺 binding 时优先复用宿主最近活跃会话。 */
export class ResolveSlashCommandContextUseCase implements SlashCommandContextResolver {
  constructor(private readonly dependencies: {
    bindingStore: ToolSessionBindingStore;
    ownershipResolver: OpencodeSessionOwnershipResolver;
    modelOverrideStore: SessionModelOverrideStore;
    hostSessionCreationPort: HostSessionCreationPort;
    hostSessionQueryPort: HostSessionQueryPort;
  }) {}

  async resolve(
    anchor: ExternalConversationAnchor,
    createContext?: HostSessionCreateContext,
    logger?: BridgeLogger,
  ): Promise<SlashCommandContext> {
    const existing = this.dependencies.bindingStore.get(anchor);
    if (existing?.status === 'active') {
      const session = await this.dependencies.hostSessionQueryPort.getSession(existing.activeOpencodeSessionId);
      // existing binding 的普通 chat 也刷新最近使用者，供 TUI detached outbound run 解析回流目标。
      this.dependencies.ownershipResolver.attach(existing.activeOpencodeSessionId, anchor);
      return {
        anchor,
        activeOpencodeSessionId: existing.activeOpencodeSessionId,
        scope: this.buildScope(session),
        modelOverride: this.dependencies.modelOverrideStore.get(existing.activeOpencodeSessionId),
        bootstrapSource: 'existing_binding',
      };
    }

    const recentSessions = await this.dependencies.hostSessionQueryPort.listSessions({});
    const recentSession = recentSessions[0];
    if (recentSession) {
      this.detachPreviousOwnership(existing, recentSession.id);
      this.dependencies.bindingStore.bind(anchor, recentSession.id);
      this.dependencies.ownershipResolver.attach(recentSession.id, anchor);
      logger?.info('slash_context.bootstrap_reused_recent_session', {
        anchor,
        opencodeSessionId: recentSession.id,
        recoveredFromInvalid: existing?.status === 'invalid',
      });

      return {
        anchor,
        activeOpencodeSessionId: recentSession.id,
        scope: this.buildScope(recentSession),
        modelOverride: this.dependencies.modelOverrideStore.get(recentSession.id),
        bootstrapSource: 'bootstrap_reused_recent_session',
      };
    }

    const created = await this.dependencies.hostSessionCreationPort.createSession(createContext);
    this.detachPreviousOwnership(existing, created.id);
    this.dependencies.bindingStore.bind(anchor, created.id);
    this.dependencies.ownershipResolver.attach(created.id, anchor);
    logger?.info('slash_context.bootstrap_created', {
      anchor,
      opencodeSessionId: created.id,
      recoveredFromInvalid: existing?.status === 'invalid',
    });

    return {
      anchor,
      activeOpencodeSessionId: created.id,
      scope: this.buildScope(created),
      bootstrapSource: 'bootstrap_created',
    };
  }

  private buildScope(session: {
    projectID?: string;
    workspaceID?: string;
    directory?: string;
  }) {
    return {
      ...(session.projectID ? { projectID: session.projectID } : {}),
      ...(session.workspaceID ? { workspaceID: session.workspaceID } : {}),
      ...(session.directory ? { directory: session.directory } : {}),
    };
  }

  private detachPreviousOwnership(
    existing: { activeOpencodeSessionId: string } | undefined,
    nextSessionId: string,
  ): void {
    if (!existing || existing.activeOpencodeSessionId === nextSessionId) {
      return;
    }
    this.dependencies.ownershipResolver.detach(existing.activeOpencodeSessionId);
  }
}
