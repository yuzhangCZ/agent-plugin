import type { AnchorBindingRecord } from '../dto/records/index.js';

export interface AnchorBindingRepository {
  get(toolSessionId: string): Promise<AnchorBindingRecord | undefined>;
  findBySessionId(sessionId: string): Promise<AnchorBindingRecord[]>;
  upsert(record: AnchorBindingRecord): Promise<void>;
  delete(toolSessionId: string): Promise<void>;
}
