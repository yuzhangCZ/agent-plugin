import type { ToolErrorMessage } from '@agent-plugin/gateway-schema';

import { normalizeErrorMessage } from '../runtime-error.ts';
import { GATEWAY_UPLINK_MESSAGE_TYPE } from '../constants/gateway-messages.ts';
import type { OutboundSink } from '../ports/outbound-sink.ts';
import type { RuntimeObservation } from '../runtime-observation/index.ts';
import { ToolErrorMessageCatalog, type ToolErrorMessageKey } from '../projectors/ToolErrorMessageCatalog.ts';

export type ToolErrorReportStage =
  | 'inbound_invalid'
  | 'command_failure'
  | 'request_lifecycle'
  | 'request_terminal'
  | 'outbound_terminal';

export type ToolErrorReportInput = {
  stage: ToolErrorReportStage;
  toolSessionId?: string;
  welinkSessionId?: string;
  reason?: ToolErrorMessage['reason'];
  messageKey?: ToolErrorMessageKey;
  error?: string;
  fallbackError?: unknown;
};

/**
 * `tool_error` 统一上报出口。
 */
export class ToolErrorReporter {
  private readonly sink: OutboundSink;
  private readonly observation: RuntimeObservation;
  private readonly catalog: ToolErrorMessageCatalog;

  constructor(
    sink: OutboundSink,
    observation: RuntimeObservation,
    catalog = new ToolErrorMessageCatalog(),
  ) {
    this.sink = sink;
    this.observation = observation;
    this.catalog = catalog;
  }

  report(input: ToolErrorReportInput): ToolErrorMessage | null {
    const message = this.toMessage(input);
    if (!message) {
      return null;
    }
    this.observation.uplinkEmitted(message);
    this.sink.send(message);
    return message;
  }

  toMessage(input: ToolErrorReportInput): ToolErrorMessage | null {
    const error = input.error
      ?? (input.messageKey ? this.catalog.get(input.messageKey) : undefined)
      ?? (input.fallbackError === undefined ? undefined : normalizeErrorMessage(input.fallbackError));
    if (!error) {
      return null;
    }

    return {
      type: GATEWAY_UPLINK_MESSAGE_TYPE.toolError,
      ...(input.welinkSessionId ? { welinkSessionId: input.welinkSessionId } : {}),
      ...(input.toolSessionId ? { toolSessionId: input.toolSessionId } : {}),
      error,
      ...(input.reason ? { reason: input.reason } : {}),
    };
  }
}
