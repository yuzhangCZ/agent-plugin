import type { CreateSessionResultData } from '../contracts/downstream-messages.js';
import type { ActionResult } from '../types/action-runtime.js';
import type { BridgeLogger } from '../types/logger.js';

export interface SessionGatewayPort {
  createSession(parameters: {
    title?: string;
    directory?: string;
  }): Promise<ActionResult<CreateSessionResultData>>;
  promptSession(parameters: {
    sessionId: string;
    text: string;
    agent?: string;
    logger?: BridgeLogger;
  }): Promise<ActionResult<void>>;
}
