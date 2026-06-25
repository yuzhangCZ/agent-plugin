import { validateGatewayUplinkBusinessMessage, type GatewayUplinkBusinessMessage } from '@agent-plugin/gateway-schema';

import { RUNTIME_FAILURE_KIND } from '../../application/constants/runtime.ts';
import type { GatewayRuntimeDriver } from '../../application/ports/gateway-runtime-driver.ts';
import type { OutboundSink } from '../../application/ports/outbound-sink.ts';
import type { RuntimeObservation } from '../../application/runtime-observation/index.ts';

/**
 * uplink validation + send 适配器。
 */
export class GatewayOutboundSinkAdapter implements OutboundSink {
  private readonly driver: GatewayRuntimeDriver;
  private readonly observation: RuntimeObservation;

  constructor(
    driver: GatewayRuntimeDriver,
    observation: RuntimeObservation,
  ) {
    this.driver = driver;
    this.observation = observation;
  }

  send(message: GatewayUplinkBusinessMessage): void {
    this.observation.uplinkSending(message);
    const validation = validateGatewayUplinkBusinessMessage(message);
    if (!validation.ok) {
      this.observation.uplinkValidationFailed(
        message,
        validation.error.violation.code,
        validation.error.violation.field,
        validation.error.violation.message,
        validation.error.violation.eventType,
      );
      this.observation.failureRecorded(
        RUNTIME_FAILURE_KIND.outboundValidation,
        'runtime',
        validation.error.violation.message,
        validation.error.violation.code,
      );
      return;
    }
    this.observation.uplinkValidated(validation.value);
    this.driver.send(validation.value);
  }
}
