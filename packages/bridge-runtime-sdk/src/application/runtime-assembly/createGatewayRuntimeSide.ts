import { GatewayInboundPolicy } from '../../adapters/gateway/GatewayInboundPolicy.ts';
import { GatewayOutboundSinkAdapter } from '../../adapters/gateway/GatewayOutboundSinkAdapter.ts';
import { GatewayRuntimeDriver } from '../../adapters/gateway/GatewayRuntimeDriver.ts';
import type { BridgeRuntimeOptions } from '../create-runtime.ts';
import type { InboundPolicy } from '../ports/inbound-policy.ts';
import type { DefaultRuntimeObservation } from '../runtime-observation/index.ts';
import type { BridgeRuntimeInternalOptions } from './runtime-options.types.ts';

export function createGatewayRuntimeSide(
  options: BridgeRuntimeOptions,
  internalOptions: BridgeRuntimeInternalOptions,
  observation: DefaultRuntimeObservation,
): {
  driver: GatewayRuntimeDriver;
  sink: GatewayOutboundSinkAdapter;
} {
  let inboundPolicyImpl: GatewayInboundPolicy | null = null;
  const inboundPolicyProxy: InboundPolicy = {
    handle(frame, input) {
      inboundPolicyImpl?.handle(frame, input);
    },
  };

  const driver = new GatewayRuntimeDriver({
    gatewayHost: options.gatewayHost,
    logger: options.logger,
    debug: options.debug,
    observation,
    inboundPolicy: inboundPolicyProxy,
    onTelemetryUpdated: options.onTelemetryUpdated,
    connectionFactory: internalOptions.connectionFactory,
    onGatewayConnectionCreated: internalOptions.onGatewayConnectionCreated,
  });
  const sink = new GatewayOutboundSinkAdapter(driver, observation);
  inboundPolicyImpl = new GatewayInboundPolicy(observation, sink);

  return {
    driver,
    sink,
  };
}
