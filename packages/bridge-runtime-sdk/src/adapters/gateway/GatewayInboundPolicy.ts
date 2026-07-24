import type { GatewayInboundFrame } from '@agent-plugin/gateway-client';
import type { WireViolation } from '@agent-plugin/gateway-schema';

import { RUNTIME_FAILURE_KIND } from '../../application/constants/runtime.ts';
import { ToolErrorMessageCatalog } from '../../application/projectors/ToolErrorMessageCatalog.ts';
import type { InboundPolicy } from '../../application/ports/inbound-policy.ts';
import type { ToolErrorReporter } from '../../application/reporters/index.ts';
import type { RuntimeObservation } from '../../application/runtime-observation/index.ts';

type InvalidInvokeGatewayInboundFrame = Extract<GatewayInboundFrame, { kind: 'invalid' }> & {
  messageType: 'invoke';
};

/**
 * invalid invoke fail-closed 策略。
 */
export class GatewayInboundPolicy implements InboundPolicy {
  private readonly observation: RuntimeObservation;
  private readonly toolErrorReporter: ToolErrorReporter;
  private readonly catalog: ToolErrorMessageCatalog;

  constructor(
    observation: RuntimeObservation,
    toolErrorReporter: ToolErrorReporter,
    catalog: ToolErrorMessageCatalog,
  ) {
    this.observation = observation;
    this.toolErrorReporter = toolErrorReporter;
    this.catalog = catalog;
  }

  handle(frame: GatewayInboundFrame, input: { isGatewayReady: boolean }): void {
    if (!this.shouldReplyToInvalidInvoke(frame)) {
      return;
    }

    this.observation.failureRecorded(
      RUNTIME_FAILURE_KIND.inboundValidation,
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

    this.toolErrorReporter.report({
      stage: 'inbound_invalid',
      level: 'P0',
      welinkSessionId: frame.welinkSessionId,
      toolSessionId: frame.toolSessionId,
      error: this.buildInvalidInvokeToolError(frame.violation.violation),
    });
  }

  private shouldReplyToInvalidInvoke(frame: GatewayInboundFrame): frame is InvalidInvokeGatewayInboundFrame {
    return frame.kind === 'invalid' && frame.messageType === 'invoke';
  }

  private buildInvalidInvokeToolError(violation: WireViolation): string {
    const segment = violation.code === 'unsupported_action' ? violation.action : violation.field;
    return this.catalog.get(violation.code, segment);
  }
}
