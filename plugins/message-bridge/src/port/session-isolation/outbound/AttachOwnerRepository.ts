import type { AttachOwnerRecord } from '../dto/records/index.js';

export interface AttachOwnerRepository {
  get(sessionId: string): Promise<AttachOwnerRecord | undefined>;
  upsert(record: AttachOwnerRecord): Promise<void>;
  delete(sessionId: string): Promise<void>;
}
