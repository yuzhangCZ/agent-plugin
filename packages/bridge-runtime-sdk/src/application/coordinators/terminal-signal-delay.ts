import type { ToolDoneMessage, ToolErrorMessage } from '@agent-plugin/gateway-schema';

import { DEFAULT_TOOL_DONE_COMPAT_DELAY_MS } from '../constants/runtime.ts';

/**
 * 对 legacy `tool_done` 做短期兼容延迟，避免服务端按完成态过早收口导致消息丢失。
 */
export async function delayBeforeTerminalToolDone(
  uplink: ToolDoneMessage | ToolErrorMessage,
  options: {
    delay?: (ms: number) => Promise<void>;
    delayMs?: number;
  },
): Promise<void> {
  if (uplink.type !== 'tool_done' || !options.delay) {
    return;
  }

  await options.delay(options.delayMs ?? DEFAULT_TOOL_DONE_COMPAT_DELAY_MS);
}
