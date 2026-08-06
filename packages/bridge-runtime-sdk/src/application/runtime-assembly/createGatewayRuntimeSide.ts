import { GatewayInboundPolicy } from '../../adapters/gateway/GatewayInboundPolicy.ts';
import { GatewayOutboundSinkAdapter } from '../../adapters/gateway/GatewayOutboundSinkAdapter.ts';
import { GatewayProbeDriver } from '../../adapters/gateway/GatewayProbeDriver.ts';
import { GatewayRuntimeDriver } from '../../adapters/gateway/GatewayRuntimeDriver.ts';
import { ToolErrorMessageCatalog } from '../projectors/ToolErrorMessageCatalog.ts';
import type { BridgeRuntimeOptions } from '../create-runtime.ts';
import type { InboundPolicy } from '../ports/inbound-policy.ts';
import { ToolErrorReporter } from '../reporters/index.ts';
import type { DefaultRuntimeObservation } from '../runtime-observation/index.ts';
import type { BridgeRuntimeInternalOptions } from './runtime-options.types.ts';

export function createGatewayRuntimeSide(
  options: BridgeRuntimeOptions,
  internalOptions: BridgeRuntimeInternalOptions,
  observation: DefaultRuntimeObservation,
): {
  runtimeDriver: GatewayRuntimeDriver;
  probeDriver: GatewayProbeDriver;
  sink: GatewayOutboundSinkAdapter;
} {
  let inboundPolicyImpl: GatewayInboundPolicy | null = null;
  const inboundPolicyProxy: InboundPolicy = {
    handle(frame, input) {
      inboundPolicyImpl?.handle(frame, input);
    },
  };

  const runtimeDriver = new GatewayRuntimeDriver({
    gatewayHost: options.gatewayHost,
    logger: options.logger,
    debug: options.debug,
    observation,
    inboundPolicy: inboundPolicyProxy,
    onTelemetryUpdated: options.onTelemetryUpdated,
    connectionFactory: internalOptions.connectionFactory,
    onGatewayConnectionCreated: internalOptions.onGatewayConnectionCreated,
  });
  const probeDriver = new GatewayProbeDriver({
    gatewayHost: options.gatewayHost,
    logger: options.logger,
    debug: options.debug,
    observation,
    connectionFactory: internalOptions.connectionFactory,
  });
  const sink = new GatewayOutboundSinkAdapter(runtimeDriver, observation);
  const toolErrorReporter = new ToolErrorReporter(sink, observation);
  inboundPolicyImpl = new GatewayInboundPolicy(observation, toolErrorReporter, new ToolErrorMessageCatalog());

  return {
    runtimeDriver,
    probeDriver,
    sink,
  };
}
