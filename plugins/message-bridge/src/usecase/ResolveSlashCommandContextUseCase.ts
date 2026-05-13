import type {
  HostSessionCreationPort,
  HostSessionQueryPort,
  SessionModelOverrideStore,
  SlashCommandContext,
  SlashCommandContextResolver,
  ToolSessionBindingStore,
  OpencodeSessionOwnershipResolver,
  ExternalConversationAnchor,
} from '../port/SlashCommandControlPlanePort.js';
import type { BridgeLogger } from '../types/logger.js';

/** 解析 slash/chat 共用的 binding 上下文，并在缺 binding 时自动 bootstrap。 */
export class ResolveSlashCommandContextUseCase implements SlashCommandContextResolver {
  constructor(private readonly dependencies: {
    bindingStore: ToolSessionBindingStore;
    ownershipResolver: OpencodeSessionOwnershipResolver;
    modelOverrideStore: SessionModelOverrideStore;
    hostSessionCreationPort: HostSessionCreationPort;
    hostSessionQueryPort: HostSessionQueryPort;
  }) {}

  async resolve(anchor: ExternalConversationAnchor, logger?: BridgeLogger): Promise<SlashCommandContext> {
    const existing = this.dependencies.bindingStore.get(anchor);
    if (existing && existing.status === 'active') {
      const session = await this.dependencies.hostSessionQueryPort.getSession(existing.activeOpencodeSessionId);
      return {
        anchor,
        activeOpencodeSessionId: existing.activeOpencodeSessionId,
        scope: this.buildScope(session),
        modelOverride: this.dependencies.modelOverrideStore.get(existing.activeOpencodeSessionId),
        bootstrapSource: 'existing_binding',
      };
    }

    const created = await this.dependencies.hostSessionCreationPort.createSession();
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
      bootstrapSource: existing?.status === 'invalid' ? 'binding_invalidated' : 'bootstrap_created',
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
}
