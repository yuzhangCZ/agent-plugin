import type { RuntimeAnchorRepository } from '../../../usecase/session-isolation/index.js';

/**
 * SDK runtime 进程内 anchor-only 注册表。
 * @remarks anchor-only 只承担兼容期 runtime conversation identity，不代表真实 host session。
 */
export class RuntimeAnchorRegistry implements RuntimeAnchorRepository {
  private readonly anchorOnlyToolSessionIds = new Set<string>();

  async createAnchorOnly(input: { toolSessionId: string }): Promise<void> {
    this.anchorOnlyToolSessionIds.add(input.toolSessionId);
  }

  async delete(toolSessionId: string): Promise<void> {
    this.anchorOnlyToolSessionIds.delete(toolSessionId);
  }

  async isAnchorOnly(toolSessionId: string): Promise<boolean> {
    return this.anchorOnlyToolSessionIds.has(toolSessionId);
  }
}
