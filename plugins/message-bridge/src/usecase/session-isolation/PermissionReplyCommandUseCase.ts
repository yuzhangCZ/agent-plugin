import type { PermissionReplyCommandPort } from '../../port/session-isolation/inbound/index.js';
import type {
  InteractionLookupBridge,
  SdkExecutionBridge,
} from '../../port/session-isolation/outbound/index.js';
import type { PermissionReplyCommandInput } from '../../port/session-isolation/dto/commands/index.js';
import type { PermissionReplyCommandResult } from '../../port/session-isolation/dto/results/index.js';

/**
 * permission reply 的应用层入口：pending permission 未命中时 fail-closed，避免误回放到非当前 anchor。
 */
export class DefaultPermissionReplyCommandUseCase implements PermissionReplyCommandPort {
  constructor(private readonly dependencies: {
    interactionLookupBridge: InteractionLookupBridge;
    sdkExecutionBridge: SdkExecutionBridge;
  }) {}

  async execute(input: PermissionReplyCommandInput): Promise<PermissionReplyCommandResult> {
    const lookup = await this.dependencies.interactionLookupBridge.findPermission(input.permissionId);
    if (lookup.kind !== 'found') {
      throw new Error(`permission interaction not found: ${input.permissionId}`);
    }

    return this.dependencies.sdkExecutionBridge.replyPermission(input);
  }
}
