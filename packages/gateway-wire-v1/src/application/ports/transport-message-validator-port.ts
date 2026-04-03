import type { UpstreamTransportMessage } from '../../contract/schemas/upstream.ts';
import type { Result } from '../../shared/result.ts';
import type { WireContractViolation } from '../../contract/errors/wire-errors.ts';
import type { UnknownBoundaryInput } from '../../shared/boundary-types.ts';

/** 上行端口：校验所有 plugin -> gateway 的 transport 消息是否可以真正发送。 */
export interface TransportMessageValidatorPort {
  validate(raw: UnknownBoundaryInput): Result<UpstreamTransportMessage, WireContractViolation>;
}
