import type { SessionScopedActionGatewayPort } from '../../../port/SessionScopedActionGatewayPort.js';
import type {
  AbortAnchoredRunInput,
  PermissionReplyCommandInput,
  QuestionReplyCommandInput,
} from '../../../port/session-isolation/dto/commands/index.js';
import type {
  AbortAnchoredRunResult,
  RuntimeAppliedResult,
} from '../../../port/session-isolation/dto/results/index.js';
import type {
  AnchorBindingRepository,
  SdkExecutionBridge,
} from '../../../port/session-isolation/index.js';

export class SessionScopedSdkExecutionBridge implements SdkExecutionBridge {
  constructor(private readonly dependencies: {
    anchorBindingRepository: AnchorBindingRepository;
    gatewayPort: Pick<SessionScopedActionGatewayPort, 'abortSession' | 'replyQuestion' | 'replyPermission'>;
  }) {}

  async abort(input: AbortAnchoredRunInput): Promise<AbortAnchoredRunResult> {
    const binding = await this.dependencies.anchorBindingRepository.get(input.toolSessionId);
    if (!binding?.sessionId || binding.state !== 'attached') {
      return {
        kind: 'not_active',
        toolSessionId: input.toolSessionId,
      };
    }

    const result = await this.dependencies.gatewayPort.abortSession({
      sessionId: binding.sessionId,
    });
    this.assertApplied(result);
    return {
      kind: 'aborted',
      toolSessionId: input.toolSessionId,
    };
  }

  async replyQuestion(input: QuestionReplyCommandInput): Promise<RuntimeAppliedResult> {
    // OpenCode reply token 全局唯一；sessionId 已在 lookup 阶段用于隔离校验，这里不再参与 SDK 调用。
    const result = await this.dependencies.gatewayPort.replyQuestion({
      questionId: input.questionId,
      answer: input.answer,
    });
    this.assertApplied(result);
    return { applied: true };
  }

  async replyPermission(input: PermissionReplyCommandInput): Promise<RuntimeAppliedResult> {
    // OpenCode reply token 全局唯一；sessionId 已在 lookup 阶段用于隔离校验，这里不再参与 SDK 调用。
    const result = await this.dependencies.gatewayPort.replyPermission({
      permissionId: input.permissionId,
      response: input.response,
    });
    this.assertApplied(result);
    return { applied: true };
  }

  private assertApplied(result: { success: boolean; errorMessage?: string }): void {
    if (!result.success) {
      throw new Error(result.errorMessage ?? 'sdk_execution_failed');
    }
  }
}
