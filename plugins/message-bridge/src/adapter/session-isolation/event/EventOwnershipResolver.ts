import type { AttachOwnerRepository } from '../../../port/session-isolation/outbound/index.js';
import type { EventOwnershipResolution } from '../../../port/session-isolation/dto/results/index.js';

export interface EventOwnershipResolver {
  resolve(rawSessionId: string): Promise<EventOwnershipResolution>;
}

/**
 * 基于 attach owner 查询宿主 session 当前归属的 runtime anchor。
 */
export class DefaultEventOwnershipResolver implements EventOwnershipResolver {
  constructor(private readonly dependencies: {
    attachOwnerRepository: AttachOwnerRepository;
  }) {}

  async resolve(rawSessionId: string): Promise<EventOwnershipResolution> {
    const owner = await this.dependencies.attachOwnerRepository.get(rawSessionId);
    if (!owner) {
      return { kind: 'unowned', sessionId: rawSessionId };
    }

    return {
      kind: 'owned',
      sessionId: rawSessionId,
      toolSessionId: owner.toolSessionId,
    };
  }
}
