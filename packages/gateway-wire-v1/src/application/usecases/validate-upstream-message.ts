import type { ProtocolFailureReporterPort } from '../ports/protocol-failure-reporter-port.ts';
import type { TransportMessageValidatorPort } from '../ports/transport-message-validator-port.ts';
import type { UpstreamTransportMessage } from '../../contract/schemas/upstream.ts';
import type { Result } from '../../shared/result.ts';
import type { WireContractViolation } from '../../contract/errors/wire-errors.ts';
import type { UnknownBoundaryInput } from '../../shared/boundary-types.ts';

export interface ValidateUpstreamMessageInput {
  raw: UnknownBoundaryInput;
}

export interface ValidateUpstreamMessageDeps {
  validator: TransportMessageValidatorPort;
  reporter?: ProtocolFailureReporterPort;
}

export function validateUpstreamMessageUseCase(
  input: ValidateUpstreamMessageInput,
  deps: ValidateUpstreamMessageDeps,
): Result<UpstreamTransportMessage, WireContractViolation> {
  const result = deps.validator.validate(input.raw);
  if (!result.ok) {
    deps.reporter?.report(result.error.violation);
  }
  return result;
}
