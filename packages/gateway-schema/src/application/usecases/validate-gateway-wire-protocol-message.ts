import type { ProtocolFailureReporterPort } from '../ports/protocol-failure-reporter-port.ts';
import type { TransportMessageValidatorPort } from '../ports/transport-message-validator-port.ts';
import type { GatewayWireProtocol } from '../../contract/schemas/upstream.ts';
import type { Result } from '../../shared/result.ts';
import type { WireContractViolation } from '../../contract/errors/wire-errors.ts';
import type { UnknownBoundaryInput } from '../../shared/boundary-types.ts';

export interface ValidateGatewayWireProtocolMessageInput {
  raw: UnknownBoundaryInput;
}

export interface ValidateGatewayWireProtocolMessageDeps {
  validator: TransportMessageValidatorPort;
  reporter?: ProtocolFailureReporterPort;
}

export function validateGatewayWireProtocolMessageUseCase(
  input: ValidateGatewayWireProtocolMessageInput,
  deps: ValidateGatewayWireProtocolMessageDeps,
): Result<GatewayWireProtocol, WireContractViolation> {
  const result = deps.validator.validate(input.raw);
  if (!result.ok) {
    deps.reporter?.report(result.error.violation);
  }
  return result;
}
