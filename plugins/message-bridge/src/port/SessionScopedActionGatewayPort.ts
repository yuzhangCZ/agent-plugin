import type {
  AbortSessionResultData,
  CloseSessionResultData,
  PermissionReplyPayload,
  PermissionReplyResultData,
  QuestionReplyResultData,
} from '../contracts/downstream-messages.js';
import type { ActionResult } from '../types/action-runtime.js';
import type { BridgeLogger } from '../types/logger.js';
import type { SessionModelOverride } from './SlashCommandControlPlanePort.js';

export type PromptSessionTerminalErrorCode =
  | 'session_not_found'
  | 'not_found'
  | 'invalid_input'
  | 'not_supported'
  | 'timeout'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'internal_error';

export interface PromptSessionAssistantError {
  name: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface PromptSessionAssistantTokens {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
}

export interface PromptSessionToolState {
  status: 'pending' | 'running' | 'completed' | 'error';
  input?: Record<string, unknown>;
  raw?: string;
  title?: string;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface PromptSessionMessagePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
  reason?: string;
  tokens?: PromptSessionAssistantTokens;
  cost?: number;
  tool?: {
    callID?: string;
    name?: string;
  };
  state?: PromptSessionToolState;
}

export type PromptSessionTerminal =
  | { kind: 'completed' }
  | {
    kind: 'failed';
    errorCode: PromptSessionTerminalErrorCode;
    errorMessage: string;
    errorDetails?: Record<string, unknown>;
  }
  | { kind: 'aborted' };

export interface PromptSessionResultData {
  message: {
    info: {
      id: string;
      error?: PromptSessionAssistantError;
      finish?: string;
      cost: number;
      tokens: PromptSessionAssistantTokens;
    };
    parts: PromptSessionMessagePart[];
  };
  terminal: PromptSessionTerminal;
}

export interface SessionScopedActionGatewayPort {
  promptSession(parameters: {
    sessionId: string;
    text: string;
    agent?: string;
    modelOverride?: SessionModelOverride;
    logger?: BridgeLogger;
  }): Promise<ActionResult<PromptSessionResultData>>;
  abortSession(parameters: {
    sessionId: string;
    logger?: BridgeLogger;
  }): Promise<ActionResult<AbortSessionResultData>>;
  closeSession(parameters: {
    sessionId: string;
    logger?: BridgeLogger;
  }): Promise<ActionResult<CloseSessionResultData>>;
  replyPermission(parameters: {
    permissionId: string;
    response: PermissionReplyPayload['response'];
    logger?: BridgeLogger;
  }): Promise<ActionResult<PermissionReplyResultData>>;
  replyQuestion(parameters: {
    questionId: string;
    answer: string;
    logger?: BridgeLogger;
  }): Promise<ActionResult<QuestionReplyResultData>>;
}
