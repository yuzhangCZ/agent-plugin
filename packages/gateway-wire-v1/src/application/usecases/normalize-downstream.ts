import type { DownstreamNormalizerPort } from '../ports/downstream-normalizer-port.ts';
import type { ProtocolFailureReporterPort } from '../ports/protocol-failure-reporter-port.ts';
import type { DownstreamMessage } from '../../contract/schemas/downstream.ts';
import type { Result } from '../../shared/result.ts';
import type { WireContractViolation } from '../../contract/errors/wire-errors.ts';
import type { UnknownBoundaryInput } from '../../shared/boundary-types.ts';

export interface NormalizeDownstreamInput {
  raw: UnknownBoundaryInput;
}

export interface NormalizeDownstreamDeps {
  normalizer: DownstreamNormalizerPort;
  reporter?: ProtocolFailureReporterPort;
}

export function normalizeDownstreamUseCase(
  input: NormalizeDownstreamInput,
  deps: NormalizeDownstreamDeps,
): Result<DownstreamMessage, WireContractViolation> {
  const result = deps.normalizer.normalize(input.raw);
  if (!result.ok) {
    deps.reporter?.report(result.error.violation);
  }
  return result;
}
