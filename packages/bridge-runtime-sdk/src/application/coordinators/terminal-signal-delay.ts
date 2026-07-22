import type { ToolDoneMessage, ToolErrorMessage } from '@agent-plugin/gateway-schema';

/**
 * 对 legacy `tool_done` 做短期兼容延迟，避免服务端按完成态过早收口导致消息丢失。
 */
export async function delayBeforeTerminalToolDone(
  uplink: ToolDoneMessage | ToolErrorMessage,
  options: {
    sleep: (ms: number) => Promise<void>;
    delayMs: number;
  },
): Promise<void> {
  if (uplink.type !== 'tool_done' || options.delayMs <= 0) {
    return;
  }

  // await options.sleep(options.delayMs);
}
