import type { CloseOwnedSessionInput } from '../dto/commands/index.js';
import type { CloseOwnedSessionResult } from '../dto/results/index.js';

export interface CloseSessionCommandPort {
  execute(input: CloseOwnedSessionInput): Promise<CloseOwnedSessionResult>;
}
