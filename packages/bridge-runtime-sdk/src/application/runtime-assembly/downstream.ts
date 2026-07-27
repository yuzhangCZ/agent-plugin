import type { GatewayDownstreamBusinessRequest } from '@agent-plugin/gateway-schema';

import { toRuntimeCommand } from '../../adapters/gateway/GatewayDownstreamCommandAdapter.ts';
import { RuntimeContractError } from '../../domain/errors.ts';
import { RUNTIME_FAILURE_KIND } from '../constants/runtime.ts';
import type { RuntimeLifecycleService } from '../lifecycle/RuntimeLifecycleService.ts';
import type { GatewayRuntimeDriver } from '../ports/gateway-runtime-driver.ts';
import type { CommandFailureToolErrorProjector } from '../projectors/CommandFailureToolErrorProjector.ts';
import type { ToolErrorReporter } from '../reporters/index.ts';
import type { DefaultRuntimeObservation } from '../runtime-observation/index.ts';
import type { RuntimeCoreService } from '../runtime/RuntimeCoreService.ts';

export function attachRuntimeDriverHandlers(input: {
  driver: GatewayRuntimeDriver;
  core: RuntimeCoreService;
  lifecycle: RuntimeLifecycleService;
  observation: DefaultRuntimeObservation;
  traceIdFactory: () => string;
  commandFailureToolErrorProjector: CommandFailureToolErrorProjector;
  toolErrorReporter: ToolErrorReporter;
}): void {
  input.driver.attach({
    onGatewayStatusChanged: (status) => {
      input.lifecycle.handleGatewayStatusChanged(status);
    },
    onBusinessMessage: (message: GatewayDownstreamBusinessRequest) => {
      const summary = summarizeDownstreamMessage(message);
      input.observation.downstreamReceived(summary);
      void (async () => {
        try {
          const traceId = input.traceIdFactory();
          const command = toRuntimeCommand(message, traceId);
          const handledCommand = await input.core.handleCommand(command);
          input.observation.downstreamHandled(summary, handledCommand);
        } catch (error) {
          input.observation.downstreamFailed(
            summary,
            error,
            error instanceof RuntimeContractError ? error.code : undefined,
          );
          input.lifecycle.recordFailure(
            isUnsupportedDownstreamAction(error)
              ? RUNTIME_FAILURE_KIND.inboundValidation
              : classifyRequestFailureKind(error),
            'runtime',
            error,
            error instanceof RuntimeContractError ? error.code : undefined,
          );
          const toolError = input.commandFailureToolErrorProjector.project({ summary, error });
          if (toolError) {
            input.toolErrorReporter.report({
              stage: 'command_failure',
              welinkSessionId: toolError.welinkSessionId,
              toolSessionId: toolError.toolSessionId,
              error: toolError.error,
              reason: toolError.reason,
            });
          }
        }
      })();
    },
  });
}

function summarizeDownstreamMessage(message: GatewayDownstreamBusinessRequest) {
  return {
    messageType: message.type,
    action: 'action' in message ? message.action : undefined,
    toolSessionId: getDownstreamToolSessionId(message),
    welinkSessionId: 'welinkSessionId' in message ? message.welinkSessionId : undefined,
  };
}

function classifyRequestFailureKind(error: unknown) {
  if (
    error instanceof RuntimeContractError
    && (error.code === 'fact_sequence_invalid' || error.code === 'pending_interaction_conflict')
  ) {
    return RUNTIME_FAILURE_KIND.outboundValidation;
  }
  return RUNTIME_FAILURE_KIND.commandExecution;
}

function getDownstreamToolSessionId(message: GatewayDownstreamBusinessRequest): string | undefined {
  if (
    'payload' in message
    && message.payload
    && typeof message.payload === 'object'
    && 'toolSessionId' in message.payload
    && typeof (message.payload as { toolSessionId?: unknown }).toolSessionId === 'string'
  ) {
    return (message.payload as { toolSessionId: string }).toolSessionId;
  }
  return undefined;
}

function isUnsupportedDownstreamAction(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Unsupported downstream action:');
}
