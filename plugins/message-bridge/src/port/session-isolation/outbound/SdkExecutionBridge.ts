import type {
  AbortAnchoredRunInput,
  PermissionReplyCommandInput,
  QuestionReplyCommandInput,
} from '../dto/commands/index.js';
import type {
  AbortAnchoredRunResult,
  RuntimeAppliedResult,
} from '../dto/results/index.js';

export interface SdkExecutionBridge {
  abort(input: AbortAnchoredRunInput): Promise<AbortAnchoredRunResult>;
  replyQuestion(input: QuestionReplyCommandInput): Promise<RuntimeAppliedResult>;
  replyPermission(input: PermissionReplyCommandInput): Promise<RuntimeAppliedResult>;
}
