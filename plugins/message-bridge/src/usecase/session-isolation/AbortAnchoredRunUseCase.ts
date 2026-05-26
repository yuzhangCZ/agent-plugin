import type { AbortSessionCommandPort } from '../../port/session-isolation/inbound/index.js';
import type { SdkExecutionBridge } from '../../port/session-isolation/outbound/index.js';
import type { AbortAnchoredRunInput } from '../../port/session-isolation/dto/commands/index.js';
import type { AbortAnchoredRunResult } from '../../port/session-isolation/dto/results/index.js';

/**
 * 中止当前 anchor 绑定的宿主运行，不参与 ownership / binding 写入。
 */
export class DefaultAbortAnchoredRunUseCase implements AbortSessionCommandPort {
  constructor(private readonly dependencies: {
    sdkExecutionBridge: SdkExecutionBridge;
  }) {}

  execute(input: AbortAnchoredRunInput): Promise<AbortAnchoredRunResult> {
    return this.dependencies.sdkExecutionBridge.abort(input);
  }
}
