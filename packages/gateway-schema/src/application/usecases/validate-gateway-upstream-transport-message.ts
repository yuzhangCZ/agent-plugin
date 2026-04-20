import type { ProtocolFailureReporterPort } from '../ports/protocol-failure-reporter-port.ts';
import type { TransportMessageValidatorPort } from '../ports/transport-message-validator-port.ts';
import type { GatewayUpstreamTransportMessage } from '../../contract/schemas/upstream.ts';
import type { Result } from '../../shared/result.ts';
import type { WireContractViolation } from '../../contract/errors/wire-errors.ts';
import type { UnknownBoundaryInput } from '../../shared/boundary-types.ts';

/** upstream transport 校验输入：保留边界原始消息，交给 validator 做统一收窄。 */
export interface ValidateGatewayUpstreamTransportMessageInput {
  raw: UnknownBoundaryInput;
}

/** upstream transport 校验依赖：显式注入 validator 与可选 reporter。 */
export interface ValidateGatewayUpstreamTransportMessageDeps {
  validator: TransportMessageValidatorPort;
  reporter?: ProtocolFailureReporterPort;
}

/**
 * upstream transport 校验入口。
 * @remarks 这里只负责 plugin -> gateway 的 control + uplink business；失败时仅对最终 violation 上报一次。
 */
export function validateGatewayUpstreamTransportMessageUseCase(
  input: ValidateGatewayUpstreamTransportMessageInput,
  deps: ValidateGatewayUpstreamTransportMessageDeps,
): Result<GatewayUpstreamTransportMessage, WireContractViolation> {
  const result = deps.validator.validate(input.raw);
  if (!result.ok) {
    deps.reporter?.report(result.error.violation);
  }
  return result;
}
