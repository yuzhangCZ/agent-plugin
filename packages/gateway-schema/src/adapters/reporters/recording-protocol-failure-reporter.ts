import type { ProtocolFailureReporterPort } from '../../application/ports/protocol-failure-reporter-port.ts';
import type { WireViolation } from '../../contract/errors/wire-errors.ts';

export class RecordingProtocolFailureReporter implements ProtocolFailureReporterPort {
  readonly violations: WireViolation[] = [];

  report(violation: WireViolation): void {
    this.violations.push(violation);
  }
}
