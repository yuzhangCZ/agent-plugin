import type { ChatPayload } from '../contracts/downstream-messages.js';
import type { SessionScopedActionGatewayPort } from '../port/SessionScopedActionGatewayPort.js';
import type { ActionResult } from '../types/action-runtime.js';
import type { BridgeLogger } from '../types/logger.js';

export interface ChatUseCaseInput {
  payload: ChatPayload;
  directory?: string;
  logger?: BridgeLogger;
}

export class ChatUseCase {
  constructor(private readonly sessionScopedActionGatewayPort: SessionScopedActionGatewayPort) {}

  async execute(input: ChatUseCaseInput): Promise<ActionResult<void>> {
    const result = await this.sessionScopedActionGatewayPort.promptSession({
      sessionId: input.payload.toolSessionId,
      text: input.payload.text,
      ...(input.directory ? { directory: input.directory } : {}),
      agent: input.payload.assistantId,
      ...(input.logger ? { logger: input.logger } : {}),
    });
    if (!result.success) {
      return result;
    }
    return { success: true };
  }
}
