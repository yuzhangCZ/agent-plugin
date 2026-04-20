import type { DownstreamNormalizerPort } from '../ports/downstream-normalizer-port.ts';
import type { ProtocolFailureReporterPort } from '../ports/protocol-failure-reporter-port.ts';
import type { TransportMessageValidatorPort } from '../ports/transport-message-validator-port.ts';
import { gatewayDownstreamEnvelopeSchema } from '../../contract/schemas/downstream.ts';
import type { GatewayWireProtocol } from '../../contract/schemas/wire-protocol.ts';
import type { Result } from '../../shared/result.ts';
import type { WireContractViolation } from '../../contract/errors/wire-errors.ts';
import type { UnknownBoundaryInput } from '../../shared/boundary-types.ts';

/** wire 校验输入：允许任意边界原始值，按当前 message family 分流到对应入口。 */
export interface ValidateGatewayWireProtocolMessageInput {
  raw: UnknownBoundaryInput;
}

/** wire 校验依赖：显式接收 downstream normalizer 与 transport validator，避免隐式 fallback 副作用。 */
export interface ValidateGatewayWireProtocolMessageDeps {
  downstreamNormalizer: DownstreamNormalizerPort;
  transportValidator: TransportMessageValidatorPort;
  reporter?: ProtocolFailureReporterPort;
}

/**
 * 全量 wire 校验入口。
 * @remarks wire 语义覆盖 downstream + upstream transport；失败时只对最终选择的校验结果上报一次。
 */
export function validateGatewayWireProtocolMessageUseCase(
  input: ValidateGatewayWireProtocolMessageInput,
  deps: ValidateGatewayWireProtocolMessageDeps,
): Result<GatewayWireProtocol, WireContractViolation> {
  const raw = input.raw;
  const result = gatewayDownstreamEnvelopeSchema.safeParse(raw).success
    ? deps.downstreamNormalizer.normalize(raw)
    : deps.transportValidator.validate(raw);

  if (!result.ok) {
    deps.reporter?.report(result.error.violation);
  }
  return result;
}
