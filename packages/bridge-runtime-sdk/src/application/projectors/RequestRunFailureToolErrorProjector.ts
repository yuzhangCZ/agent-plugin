import type { ToolErrorMessage } from '@agent-plugin/gateway-schema';

import { GATEWAY_UPLINK_MESSAGE_TYPE } from '../constants/gateway-messages.ts';
import { ToolErrorMessageCatalog } from './ToolErrorMessageCatalog.ts';

/**
 * request run 生命周期失败 -> `tool_error` projector。
 * @remarks
 * 只用于 request run 已启动后的唯一终态收口。
 */
export class RequestRunFailureToolErrorProjector {
  private readonly catalog: ToolErrorMessageCatalog;

  constructor(catalog: ToolErrorMessageCatalog) {
    this.catalog = catalog;
  }

  project(input: { toolSessionId: string; welinkSessionId?: string }): ToolErrorMessage {
    return {
      type: GATEWAY_UPLINK_MESSAGE_TYPE.toolError,
      toolSessionId: input.toolSessionId,
      error: this.catalog.get('request_run_failed'),
    };
  }
}
