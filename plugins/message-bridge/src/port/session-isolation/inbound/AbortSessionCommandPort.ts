import type { AbortAnchoredRunInput } from '../dto/commands/index.js';
import type { AbortAnchoredRunResult } from '../dto/results/index.js';

export interface AbortSessionCommandPort {
  execute(input: AbortAnchoredRunInput): Promise<AbortAnchoredRunResult>;
}
