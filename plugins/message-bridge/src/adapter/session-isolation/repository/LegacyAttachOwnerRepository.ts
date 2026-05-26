import type { OpencodeSessionOwnershipResolver } from '../../../port/SlashCommandControlPlanePort.js';
import type { AttachOwnerRepository } from '../../../port/session-isolation/index.js';
import type { AttachOwnerRecord } from '../../../port/session-isolation/dto/records/index.js';

export class LegacyAttachOwnerRepository implements AttachOwnerRepository {
  constructor(private readonly ownershipResolver: OpencodeSessionOwnershipResolver) {}

  async get(sessionId: string): Promise<AttachOwnerRecord | undefined> {
    const toolSessionId = this.ownershipResolver.resolveAttachedAnchor(sessionId);
    return toolSessionId ? { sessionId, toolSessionId } : undefined;
  }

  async upsert(record: AttachOwnerRecord): Promise<void> {
    this.ownershipResolver.attach(record.sessionId, record.toolSessionId);
  }

  async delete(sessionId: string): Promise<void> {
    this.ownershipResolver.detach(sessionId);
  }
}
