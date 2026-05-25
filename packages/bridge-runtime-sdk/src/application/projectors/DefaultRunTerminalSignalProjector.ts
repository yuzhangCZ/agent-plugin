import type { ToolDoneMessage, ToolErrorMessage } from '@agent-plugin/gateway-schema';

import {
  DEFAULT_PROVIDER_RUN_FAILURE_MESSAGE,
} from '../constants/runtime.ts';
import { GATEWAY_UPLINK_MESSAGE_TYPE } from '../constants/gateway-messages.ts';
import type { ProviderTerminalResult } from '../../domain/provider.ts';
import type { RunTerminalSignalProjector } from './projector.types.ts';

/**
 * 默认 run terminal projector。
 */
export class DefaultRunTerminalSignalProjector implements RunTerminalSignalProjector {
  project(input: {
    toolSessionId: string;
    welinkSessionId?: string;
    result: ProviderTerminalResult;
  }): ToolDoneMessage | ToolErrorMessage {
    if (input.result.outcome === 'completed' || input.result.outcome === 'aborted') {
      return {
        type: GATEWAY_UPLINK_MESSAGE_TYPE.toolDone,
        toolSessionId: input.toolSessionId,
        ...(input.welinkSessionId ? { welinkSessionId: input.welinkSessionId } : {}),
      };
    }

    return {
      type: GATEWAY_UPLINK_MESSAGE_TYPE.toolError,
      toolSessionId: input.toolSessionId,
      ...(input.welinkSessionId ? { welinkSessionId: input.welinkSessionId } : {}),
      error: input.result.error?.message ?? DEFAULT_PROVIDER_RUN_FAILURE_MESSAGE,
      ...(input.result.error?.code === 'session_not_found' ? { reason: 'session_not_found' as const } : {}),
    };
  }
}
