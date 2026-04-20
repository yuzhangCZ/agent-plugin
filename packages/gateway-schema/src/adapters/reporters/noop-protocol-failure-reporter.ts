import type { ProtocolFailureReporterPort } from '../../application/ports/protocol-failure-reporter-port.ts';

export class NoopProtocolFailureReporter implements ProtocolFailureReporterPort {
  report(): void {}
}
