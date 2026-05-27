import type { CreateSessionCommandInput } from '../dto/commands/index.js';
import type { CreateSessionCommandResult } from '../dto/results/index.js';

export interface CreateSessionCommandPort {
  execute(input: CreateSessionCommandInput): Promise<CreateSessionCommandResult>;
}
