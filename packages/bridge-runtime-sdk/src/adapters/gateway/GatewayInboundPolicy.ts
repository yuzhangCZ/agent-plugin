import type { GatewayInboundFrame } from '@agent-plugin/gateway-client';
import type { ToolErrorMessage } from '@agent-plugin/gateway-schema';

import type { InboundPolicy } from '../../application/ports/inbound-policy.ts';
import type { OutboundSink } from '../../application/ports/outbound-sink.ts';
import type { RuntimeObservation } from '../../application/runtime-observation.ts';

type InvalidInvokeGatewayInboundFrame = Extract<GatewayInboundFrame, { kind: 'invalid' }> & {
  messageType: 'invoke';
};

function shouldReplyToInvalidInvoke(frame: GatewayInboundFrame): frame is InvalidInvokeGatewayInboundFrame {
  return frame.kind === 'invalid' && frame.messageType === 'invoke';
}

function buildInvalidInvokeToolError(code: string): string {
  return `gateway_invalid_invoke:${code}`;
}

/**
 * invalid invoke fail-closed 策略。
 */
export class GatewayInboundPolicy implements InboundPolicy {
  private readonly observation: RuntimeObservation;
  private readonly sink: OutboundSink;

  constructor(
    observation: RuntimeObservation,
    sink: OutboundSink,
  ) {
    this.observation = observation;
    this.sink = sink;
  }

  handle(frame: GatewayInboundFrame, input: { isGatewayReady: boolean }): void {
    if (!shouldReplyToInvalidInvoke(frame)) {
      return;
    }

    this.observation.failureRecorded(
      'inbound_validation_failure',
      'runtime',
      frame.violation.violation.message,
      frame.violation.violation.code,
    );

    if (!frame.welinkSessionId && !frame.toolSessionId) {
      return;
    }

    if (!input.isGatewayReady) {
      return;
    }

    this.observation.invalidInvokeRejected({
      toolSessionId: frame.toolSessionId,
      welinkSessionId: frame.welinkSessionId,
    }, frame.violation.violation.message, frame.violation.violation.code);

    const toolError: ToolErrorMessage = {
      type: 'tool_error',
      ...(frame.welinkSessionId ? { welinkSessionId: frame.welinkSessionId } : {}),
      ...(frame.toolSessionId ? { toolSessionId: frame.toolSessionId } : {}),
      error: buildInvalidInvokeToolError(frame.violation.violation.code),
    };
    this.observation.uplinkEmitted(toolError);
    void this.sink.send(toolError);
  }
}
