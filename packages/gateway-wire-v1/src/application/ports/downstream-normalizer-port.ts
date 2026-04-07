import type { DownstreamMessage } from '../../contract/schemas/downstream.ts';
import type { Result } from '../../shared/result.ts';
import type { WireContractViolation } from '../../contract/errors/wire-errors.ts';
import type { UnknownBoundaryInput } from '../../shared/boundary-types.ts';

/** 下行端口：负责把 gateway 输入收窄成共享 downstream 协议对象。 */
export interface DownstreamNormalizerPort {
  normalize(raw: UnknownBoundaryInput): Result<DownstreamMessage, WireContractViolation>;
}
