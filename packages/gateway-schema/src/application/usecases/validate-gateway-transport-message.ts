import type { ProtocolFailureReporterPort } from '../ports/protocol-failure-reporter-port.ts';
import type { TransportMessageValidatorPort } from '../ports/transport-message-validator-port.ts';
import type { GatewayTransportMessage } from '../../contract/schemas/upstream.ts';
import type { Result } from '../../shared/result.ts';
import type { WireContractViolation } from '../../contract/errors/wire-errors.ts';
import type { UnknownBoundaryInput } from '../../shared/boundary-types.ts';

/** transport-only 校验输入：保留边界原始消息，交给 validator 做统一收窄。 */
export interface ValidateGatewayTransportMessageInput {
  raw: UnknownBoundaryInput;
}

/** transport-only 校验依赖：显式注入 validator 与可选 reporter。 */
export interface ValidateGatewayTransportMessageDeps {
  validator: TransportMessageValidatorPort;
  reporter?: ProtocolFailureReporterPort;
}

/**
 * transport-only 校验入口。
 * @remarks 这里只负责 transport/control + uplink business；失败时仅对最终 violation 上报一次。
 */
export function validateGatewayTransportMessageUseCase(
  input: ValidateGatewayTransportMessageInput,
  deps: ValidateGatewayTransportMessageDeps,
): Result<GatewayTransportMessage, WireContractViolation> {
  const result = deps.validator.validate(input.raw);
  if (!result.ok) {
    deps.reporter?.report(result.error.violation);
  }
  return result;
}
