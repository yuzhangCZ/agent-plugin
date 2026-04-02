import type { ChatPayload } from '../contracts/downstream-messages.js';
import type { SessionScopedActionGatewayPort } from '../port/SessionScopedActionGatewayPort.js';
import type { ActionResult } from '../types/action-runtime.js';
import type { BridgeLogger } from '../types/logger.js';

export interface ChatUseCaseInput {
  payload: ChatPayload;
  logger?: BridgeLogger;
}

export class ChatUseCase {
  constructor(private readonly sessionScopedActionGatewayPort: SessionScopedActionGatewayPort) {}

  async execute(input: ChatUseCaseInput): Promise<ActionResult<void>> {
    return this.sessionScopedActionGatewayPort.promptSession({
      sessionId: input.payload.toolSessionId,
      text: input.payload.text,
      agent: input.payload.assistantId,
      ...(input.logger ? { logger: input.logger } : {}),
    });
  }
}
