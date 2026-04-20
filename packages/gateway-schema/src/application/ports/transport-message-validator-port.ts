import type { GatewayTransportMessage } from '../../contract/schemas/upstream.ts';
import type { Result } from '../../shared/result.ts';
import type { WireContractViolation } from '../../contract/errors/wire-errors.ts';
import type { UnknownBoundaryInput } from '../../shared/boundary-types.ts';

/** transport-only 端口：校验 plugin -> gateway 的 control/business 消息是否满足发送契约。 */
export interface TransportMessageValidatorPort {
  validate(raw: UnknownBoundaryInput): Result<GatewayTransportMessage, WireContractViolation>;
}
