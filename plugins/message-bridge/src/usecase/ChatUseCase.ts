import type { ChatPayload } from '../contracts/downstream-messages.js';
import type { SessionGatewayPort } from '../port/SessionGatewayPort.js';
import type { ActionResult } from '../types/action-runtime.js';
import type { BridgeLogger } from '../types/logger.js';

export interface ChatUseCaseInput {
  payload: ChatPayload;
  logger?: BridgeLogger;
}

export class ChatUseCase {
  constructor(private readonly sessionGatewayPort: SessionGatewayPort) {}

  async execute(input: ChatUseCaseInput): Promise<ActionResult<void>> {
    return this.sessionGatewayPort.promptSession({
      sessionId: input.payload.toolSessionId,
      text: input.payload.text,
      agent: input.payload.assistantId,
      ...(input.logger ? { logger: input.logger } : {}),
    });
  }
}
