import type { ProviderFact } from '../domain/provider.ts';
import type {
  PermissionPresentationContext,
  PermissionPresentationRegistry,
} from './ports/permission-presentation-registry.ts';
import type { ProjectableProviderFact, ProjectablePermissionReplyFact } from './projectors/projectable-provider-fact.ts';

export type ProviderFactEnrichmentResult =
  | { ok: true; fact: ProjectableProviderFact }
  | {
      ok: false;
      reason: 'permission_reply_projection_missed' | 'permission_ask_projection_conflict';
      details: Record<string, unknown>;
    };

/**
 * 在进入 projector 之前补齐 permission 展示上下文。
 */
export class ProviderFactEnricher {
  private readonly registry: PermissionPresentationRegistry;

  constructor(registry: PermissionPresentationRegistry) {
    this.registry = registry;
  }

  enrich(toolSessionId: string, fact: ProviderFact): ProviderFactEnrichmentResult {
    if (fact.type === 'permission.ask') {
      return this.enrichPermissionAsk(toolSessionId, fact);
    }
    if (fact.type === 'permission.reply') {
      return this.enrichPermissionReply(toolSessionId, fact);
    }
    return { ok: true, fact };
  }

  clearSession(toolSessionId: string): void {
    this.registry.clearSession(toolSessionId);
  }

  private enrichPermissionAsk(
    toolSessionId: string,
    fact: Extract<ProviderFact, { type: 'permission.ask' }>,
  ): ProviderFactEnrichmentResult {
    const record: PermissionPresentationContext = {
      toolSessionId,
      permissionId: fact.permissionId,
      partId: fact.partId,
      ...(fact.messageId ? { messageId: fact.messageId } : {}),
      ...(fact.permissionType ? { permissionType: fact.permissionType } : {}),
      ...(fact.subagentSessionId ? { subagentSessionId: fact.subagentSessionId } : {}),
    };
    const result = this.registry.register(record);
    if (!result.ok) {
      return {
        ok: false,
        reason: 'permission_ask_projection_conflict',
        details: {
          toolSessionId,
          permissionId: fact.permissionId,
          existingPartId: result.existing.partId,
          conflictingPartId: result.current.partId,
        },
      };
    }
    return { ok: true, fact };
  }

  private enrichPermissionReply(
    toolSessionId: string,
    fact: Extract<ProviderFact, { type: 'permission.reply' }>,
  ): ProviderFactEnrichmentResult {
    const context = this.registry.get(toolSessionId, fact.permissionId);
    if (!context) {
      return {
        ok: false,
        reason: 'permission_reply_projection_missed',
        details: {
          toolSessionId,
          permissionId: fact.permissionId,
        },
      };
    }
    const enriched: ProjectablePermissionReplyFact = {
      ...fact,
      partId: context.partId,
      ...(context.messageId ? { messageId: context.messageId } : {}),
      ...(fact.permissionType === undefined && context.permissionType !== undefined
        ? { permissionType: context.permissionType }
        : {}),
    };
    return { ok: true, fact: enriched };
  }
}
