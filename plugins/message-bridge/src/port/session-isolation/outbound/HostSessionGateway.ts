import type {
  HostPromptInput,
  HostSessionCreateInput,
} from '../dto/commands/index.js';
import type { HostSessionRecord } from '../dto/records/index.js';
import type { RuntimeAppliedResult } from '../dto/results/index.js';

export interface HostSessionGateway {
  get(sessionId: string): Promise<HostSessionRecord>;
  list(input: { directory?: string }): Promise<HostSessionRecord[]>;
  create(input: HostSessionCreateInput): Promise<HostSessionRecord>;
  delete(sessionId: string): Promise<RuntimeAppliedResult>;
  prompt(input: HostPromptInput): Promise<RuntimeAppliedResult>;
}
