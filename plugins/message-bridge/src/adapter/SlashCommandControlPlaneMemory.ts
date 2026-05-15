import type {
  ExternalConversationAnchor,
  OpencodeSessionOwnershipResolver,
  SessionModelOverride,
  SessionModelOverrideStore,
  SlashCommand,
  SlashCommandParseInput,
  SlashCommandParseResult,
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
  tryParse(input: SlashCommandParseInput): SlashCommandParseResult {
    const normalized = this.normalizeInput(input);
    if (!normalized.startsWith('/')) {
      return { kind: 'none' };
    }
    return this.parseKnownCommand(normalized);
  }

  /** 群聊下仅剥离首段 `@xxx ` mention；单聊严格按原文判断。 */
  private normalizeInput(input: SlashCommandParseInput): string {
    const normalized = input.text.trim();
    if (!input.isGroupChat) {
      return normalized;
    }
    return normalized.replace(/^@\S+\s+/, '').trim();
  }

  private parseKnownCommand(normalized: string): SlashCommandParseResult {
    const standaloneCommandResult = this.parseStandaloneCommand(normalized);
    if (standaloneCommandResult) {
      return standaloneCommandResult;
    }

    const parameterizedCommandResult = this.parseParameterizedCommand(normalized);
    if (parameterizedCommandResult) {
      return parameterizedCommandResult;
    }

    return { kind: 'none' };
  }

  private parseStandaloneCommand(normalized: string): SlashCommandParseResult | undefined {
    const standaloneCommands: Array<'new' | 'sessions' | 'models'> = ['new', 'sessions', 'models'];

    for (const commandKind of standaloneCommands) {
      const exactCommand = `/${commandKind}`;
      if (normalized === exactCommand) {
        return { kind: 'matched', command: { kind: commandKind } };
      }
      if (this.matchesKnownCommand(normalized, commandKind)) {
        return { kind: 'invalid', command: { kind: commandKind } };
      }
    }

    return undefined;
  }

  private parseParameterizedCommand(normalized: string): SlashCommandParseResult | undefined {
    return this.parseSessionCommand(normalized) ?? this.parseModelCommand(normalized);
  }

  private parseSessionCommand(normalized: string): SlashCommandParseResult | undefined {
    const sessionCommandPattern = /^\/session\s+(\S+)$/u;
    const sessionMatch = normalized.match(sessionCommandPattern);
    if (sessionMatch) {
      return { kind: 'matched', command: { kind: 'session', sessionId: sessionMatch[1] } };
    }
    if (this.matchesKnownCommand(normalized, 'session')) {
      return { kind: 'invalid', command: { kind: 'session' } };
    }
    return undefined;
  }

  private parseModelCommand(normalized: string): SlashCommandParseResult | undefined {
    const modelCommandPattern = /^\/model\s+([^/\s]+)\/([^/\s]+)$/u;
    const modelMatch = normalized.match(modelCommandPattern);
    if (modelMatch) {
      return {
        kind: 'matched',
        command: {
          kind: 'model',
          providerId: modelMatch[1],
          modelId: modelMatch[2],
        },
      };
    }
    if (this.matchesKnownCommand(normalized, 'model')) {
      return { kind: 'invalid', command: { kind: 'model' } };
    }
    return undefined;
  }

  private matchesKnownCommand(normalized: string, command: SlashCommand['kind']): boolean {
    return new RegExp(`^/${command}(?:\\s|$)`, 'u').test(normalized);
  }
}
