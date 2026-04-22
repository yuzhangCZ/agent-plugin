import type { ProtocolFailureReporterPort } from '../ports/protocol-failure-reporter-port.ts';
import type { ToolEventValidatorPort } from '../ports/tool-event-validator-port.ts';
import type { GatewayToolEventPayload } from '../../contract/schemas/tool-event/index.ts';
import type { Result } from '../../shared/result.ts';
import type { WireContractViolation } from '../../contract/errors/wire-errors.ts';
import type { UnknownBoundaryInput } from '../../shared/boundary-types.ts';

export interface ValidateToolEventInput {
  raw: UnknownBoundaryInput;
}

export interface ValidateToolEventDeps {
  validator: ToolEventValidatorPort;
  reporter?: ProtocolFailureReporterPort;
}

export function validateToolEventUseCase(
  input: ValidateToolEventInput,
  deps: ValidateToolEventDeps,
): Result<GatewayToolEventPayload, WireContractViolation> {
  const result = deps.validator.validate(input.raw);
  if (!result.ok) {
    deps.reporter?.report(result.error.violation);
  }
  return result;
}
