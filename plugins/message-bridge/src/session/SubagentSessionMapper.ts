// plugins/agent-plugin/plugins/message-bridge/src/session/SubagentSessionMapper.ts

import type { OpencodeClient } from '../types/sdk.js';
import type { BridgeLogger } from '../runtime/AppLogger.js';

export interface SubagentMapping {
  parentSessionId: string;
  agentName: string;
}

/**
 * 维护子 session → 父 session 的映射。
 * 正常流程：session.created 事件主动写入缓存。
 * 兜底流程：缓存 miss 时懒查询 OpenCode API。
 */
export class SubagentSessionMapper {
  /** sessionId → mapping | null (null = 已确认是主 session) */
  private readonly cache = new Map<string, SubagentMapping | null>();
  private readonly clientProvider: () => OpencodeClient | null;
  private readonly logger: BridgeLogger;

  constructor(clientProvider: () => OpencodeClient | null, logger: BridgeLogger) {
    this.clientProvider = clientProvider;
    this.logger = logger;
  }

  /**
   * session.created 事件到达时主动写入缓存。
   * 事件结构: { type: "session.created", properties: { info: { id, parentID?, ... } } }
   */
  onSessionCreated(event: { properties?: { info?: { id?: string; parentID?: string; title?: string } } }): void {
    const info = event?.properties?.info;
    if (!info?.id) return;

    if (info.parentID) {
      const mapping: SubagentMapping = {
        parentSessionId: info.parentID,
        agentName: info.title ?? 'unknown',
      };
      this.cache.set(info.id, mapping);
      this.logger.info('subagent.mapper.cached', {
        childSessionId: info.id,
        parentSessionId: info.parentID,
        agentName: mapping.agentName,
      });
    }
    // 不缓存主 session 的 session.created（它们不需要映射）
  }

  /**
   * 查询映射。缓存命中直接返回；miss 则懒查询 OpenCode API。
   * 返回 null 表示这是主 session（无需重写）。
   */
  async resolve(sessionId: string): Promise<SubagentMapping | null> {
    // 缓存命中
    if (this.cache.has(sessionId)) {
      return this.cache.get(sessionId) ?? null;
    }

    // 缓存 miss → 懒查询
    const client = this.clientProvider();
    if (!client) {
      this.logger.warn('subagent.mapper.no_client', { sessionId });
      return null;
    }

    try {
      const result = await client.session.get({ sessionID: sessionId });
      const session = result as Record<string, unknown>;
      const parentID = session?.parentID as string | undefined;

      if (parentID) {
        const mapping: SubagentMapping = {
          parentSessionId: parentID,
          agentName: (session?.title as string) ?? 'unknown',
        };
        this.cache.set(sessionId, mapping);
        this.logger.info('subagent.mapper.lazy_cached', {
          childSessionId: sessionId,
          parentSessionId: parentID,
        });
        return mapping;
      }

      // 确认是主 session，缓存 null 避免重复查询
      this.cache.set(sessionId, null);
      return null;
    } catch (error) {
      this.logger.warn('subagent.mapper.query_failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** 清空缓存（用于测试或重置） */
  clear(): void {
    this.cache.clear();
  }
}
