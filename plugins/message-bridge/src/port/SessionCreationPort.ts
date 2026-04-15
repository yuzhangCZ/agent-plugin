import type { CreateSessionResultData } from '../contracts/downstream-messages.js';
import type { ActionResult } from '../types/action-runtime.js';

export interface SessionCreationPort {
  createSession(parameters: {
    title?: string;
    directory?: string;
    permission?: Array<Record<string, unknown>>
  }): Promise<ActionResult<CreateSessionResultData>>;
}
