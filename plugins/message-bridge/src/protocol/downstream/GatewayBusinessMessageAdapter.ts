import type { GatewayBusinessMessage } from '@agent-plugin/gateway-client';

import type { BridgeLogger } from '../../runtime/AppLogger.js';
import type { NormalizeResult, NormalizedDownstreamMessage } from './DownstreamMessageTypes.js';
import { normalizeDownstreamMessage } from './DownstreamMessageNormalizer.js';

/**
 * `message-bridge` 插件私有下行适配入口。
 *
 * @remarks
 * 共享 `gateway-client` 已经完成主链路 typed facade 归一化；这里仅补充
 * `message-bridge` 自身 bounded context 仍需保留的兼容与 fail-closed 约束，
 * 不重复实现共享 `gateway-wire-v1` 已经覆盖的 schema 校验，避免这些规则
 * 继续散落在 runtime 主流程中。
 */
export function adaptGatewayBusinessMessage(
  message: GatewayBusinessMessage,
  logger?: Pick<BridgeLogger, 'warn'>,
): NormalizeResult<NormalizedDownstreamMessage> {
  return normalizeDownstreamMessage(message, logger);
}
