import type { ChatCommandInput } from '../dto/commands/index.js';
import type { ChatCommandResult } from '../dto/results/index.js';

export interface ChatCommandPort {
  execute(input: ChatCommandInput): Promise<ChatCommandResult>;
}
