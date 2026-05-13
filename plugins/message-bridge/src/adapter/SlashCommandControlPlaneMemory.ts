import type {
  ExternalConversationAnchor,
  OpencodeSessionOwnershipResolver,
  SessionModelOverride,
  SessionModelOverrideStore,
  SlashCommand,
  SlashCommandParser,
  ToolSessionBinding,
  ToolSessionBindingStore,
} from '../port/SlashCommandControlPlanePort.js';

/**
 * 进程内 binding store。
 * @remarks 临时态只保存当前 active binding，不持久化历史。
 */
export class InMemoryToolSessionBindingStore implements ToolSessionBindingStore {
  private readonly bindings = new Map<ExternalConversationAnchor, ToolSessionBinding>();

  get(anchor: ExternalConversationAnchor): ToolSessionBinding | undefined {
    return this.bindings.get(anchor);
  }

  bind(anchor: ExternalConversationAnchor, opencodeSessionId: string): ToolSessionBinding {
    const binding: ToolSessionBinding = {
      anchor,
      activeOpencodeSessionId: opencodeSessionId,
      status: 'active',
    };
    this.bindings.set(anchor, binding);
    return binding;
  }

  invalidate(anchor: ExternalConversationAnchor): void {
    const existing = this.bindings.get(anchor);
    if (!existing) {
      return;
    }
    this.bindings.set(anchor, {
      ...existing,
      status: 'invalid',
    });
  }
}

/**
 * 进程内 ownership resolver。
 * @remarks 重绑时自动摘除同 anchor 的旧 attached owner，避免旧事件串线。
 */
export class InMemoryOpencodeSessionOwnershipResolver implements OpencodeSessionOwnershipResolver {
  private readonly bySessionId = new Map<string, { anchor: ExternalConversationAnchor; routeStatus: 'attached' | 'detached' }>();

  attach(opencodeSessionId: string, anchor: ExternalConversationAnchor): void {
    for (const [sessionId, ownership] of this.bySessionId.entries()) {
      if (ownership.anchor === anchor && ownership.routeStatus === 'attached' && sessionId !== opencodeSessionId) {
        this.bySessionId.set(sessionId, {
          ...ownership,
          routeStatus: 'detached',
        });
      }
    }

    this.bySessionId.set(opencodeSessionId, {
      anchor,
      routeStatus: 'attached',
    });
  }

  detach(opencodeSessionId: string): void {
    const existing = this.bySessionId.get(opencodeSessionId);
    if (!existing) {
      return;
    }
    this.bySessionId.set(opencodeSessionId, {
      ...existing,
      routeStatus: 'detached',
    });
  }

  resolveAttachedAnchor(opencodeSessionId: string): ExternalConversationAnchor | undefined {
    const existing = this.bySessionId.get(opencodeSessionId);
    return existing?.routeStatus === 'attached' ? existing.anchor : undefined;
  }
}

/** 进程内会话级模型覆盖存储。 */
export class InMemorySessionModelOverrideStore implements SessionModelOverrideStore {
  private readonly overrides = new Map<string, SessionModelOverride>();

  get(opencodeSessionId: string): SessionModelOverride | undefined {
    return this.overrides.get(opencodeSessionId);
  }

  set(opencodeSessionId: string, override: SessionModelOverride): void {
    this.overrides.set(opencodeSessionId, override);
  }

  clear(opencodeSessionId: string): void {
    this.overrides.delete(opencodeSessionId);
  }
}

/** 最小 slash 语法解析器，只识别控制面命令，不做业务校验。 */
export class SimpleSlashCommandParser implements SlashCommandParser {
  tryParse(text: string): SlashCommand | undefined {
    const normalized = text.trim();
    if (!normalized.startsWith('/')) {
      return undefined;
    }
    if (normalized === '/new') {
      return { kind: 'new' };
    }
    if (normalized === '/sessions') {
      return { kind: 'sessions' };
    }
    if (normalized === '/models') {
      return { kind: 'models' };
    }

    const sessionMatch = normalized.match(/^\/session\s+(\S+)$/);
    if (sessionMatch) {
      return { kind: 'session', sessionId: sessionMatch[1] };
    }

    const modelMatch = normalized.match(/^\/model\s+([^/\s]+)\/(\S+)$/);
    if (modelMatch) {
      return {
        kind: 'model',
        providerId: modelMatch[1],
        modelId: modelMatch[2],
      };
    }

    return undefined;
  }
}
