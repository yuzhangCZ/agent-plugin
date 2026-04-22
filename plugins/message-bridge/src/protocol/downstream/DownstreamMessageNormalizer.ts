/**
 * 共享 raw downstream 包装器。
 * @remarks 仅供 isolated normalization 测试或原始输入场景复用，不是 runtime typed facade 主链路入口。
 */
export {
  logDownstreamNormalizationFailure,
  normalizeDownstream,
  normalizeDownstreamMessage,
} from '../../gateway-wire/downstream.js';
