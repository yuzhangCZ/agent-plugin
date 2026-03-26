import type { CreateSessionResultData } from '../contracts/downstream-messages.js';
import type { ActionResult } from '../types/action-runtime.js';

export interface SessionGatewayPort {
  createSession(parameters: {
    title?: string;
    directory?: string;
  }): Promise<ActionResult<CreateSessionResultData>>;
  promptSession(parameters: {
    sessionId: string;
    text: string;
    directory?: string;
    agent?: string;
  }): Promise<ActionResult<void>>;
}

