import type {
  AbortSessionResultData,
  CloseSessionResultData,
  PermissionReplyPayload,
  PermissionReplyResultData,
  QuestionReplyResultData,
} from '../contracts/downstream-messages.js';
import type { ActionResult } from '../types/action-runtime.js';
import type { BridgeLogger } from '../types/logger.js';

export interface SessionScopedActionGatewayPort {
  promptSession(parameters: {
    sessionId: string;
    text: string;
    agent?: string;
    logger?: BridgeLogger;
  }): Promise<ActionResult<void>>;
  abortSession(parameters: {
    sessionId: string;
    logger?: BridgeLogger;
  }): Promise<ActionResult<AbortSessionResultData>>;
  closeSession(parameters: {
    sessionId: string;
    logger?: BridgeLogger;
  }): Promise<ActionResult<CloseSessionResultData>>;
  replyPermission(parameters: {
    sessionId: string;
    permissionId: string;
    response: PermissionReplyPayload['response'];
    logger?: BridgeLogger;
  }): Promise<ActionResult<PermissionReplyResultData>>;
  replyQuestion(parameters: {
    sessionId: string;
    toolCallId?: string;
    answer: string;
    logger?: BridgeLogger;
  }): Promise<ActionResult<QuestionReplyResultData>>;
}
