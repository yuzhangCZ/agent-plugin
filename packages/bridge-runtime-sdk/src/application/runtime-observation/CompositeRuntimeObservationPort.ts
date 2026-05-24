import type { RuntimeObservationPort } from './runtime-observation.port.ts';
import type { RuntimeObservationEvent } from './runtime-observation.types.ts';

/**
 * 组合多个 observation adapter。
 */
export class CompositeRuntimeObservationPort implements RuntimeObservationPort {
  private readonly ports: RuntimeObservationPort[];

  constructor(ports: RuntimeObservationPort[]) {
    this.ports = ports;
  }

  record(event: RuntimeObservationEvent): void {
    for (const port of this.ports) {
      port.record(event);
    }
  }
}
