import type { ToolSessionBindingStore } from '../../../port/SlashCommandControlPlanePort.js';
import type { AnchorBindingRepository } from '../../../port/session-isolation/index.js';
import type { AnchorBindingRecord } from '../../../port/session-isolation/dto/records/index.js';

type EnumerableBindingStore = ToolSessionBindingStore & {
  findBySessionId?: (opencodeSessionId: string) => Array<{
    anchor: string;
    activeOpencodeSessionId: string;
    status: 'active' | 'invalid';
  }>;
  delete?: (anchor: string) => void;
};

export class LegacyAnchorBindingRepository implements AnchorBindingRepository {
  constructor(private readonly bindingStore: EnumerableBindingStore) {}

  async get(toolSessionId: string): Promise<AnchorBindingRecord | undefined> {
    const binding = this.bindingStore.get(toolSessionId);
    return binding ? this.toRecord(binding) : undefined;
  }

  async findBySessionId(sessionId: string): Promise<AnchorBindingRecord[]> {
    return (this.bindingStore.findBySessionId?.(sessionId) ?? []).map((binding) => this.toRecord(binding));
  }

  async upsert(record: AnchorBindingRecord): Promise<void> {
    if (record.state === 'closed') {
      await this.delete(record.toolSessionId);
      return;
    }
    if (!record.sessionId) {
      return;
    }
    this.bindingStore.bind(record.toolSessionId, record.sessionId);
    if (record.state === 'anchor_only') {
      this.bindingStore.invalidate(record.toolSessionId);
    }
  }

  async delete(toolSessionId: string): Promise<void> {
    if (this.bindingStore.delete) {
      this.bindingStore.delete(toolSessionId);
      return;
    }
    this.bindingStore.invalidate(toolSessionId);
  }

  private toRecord(binding: {
    anchor: string;
    activeOpencodeSessionId: string;
    status: 'active' | 'invalid';
  }): AnchorBindingRecord {
    return {
      toolSessionId: binding.anchor,
      sessionId: binding.activeOpencodeSessionId,
      state: binding.status === 'active' ? 'attached' : 'closed',
    };
  }
}
