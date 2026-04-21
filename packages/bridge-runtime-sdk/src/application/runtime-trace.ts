import type {
  GatewayUplinkBusinessMessage,
  SkillProviderEvent,
} from '@agent-plugin/gateway-schema';

import type { ProviderFact, ProviderTerminalResult } from '../domain/provider.ts';

export interface RuntimeTraceProviderCall {
  command:
    | 'queryStatus'
    | 'createSession'
    | 'startRequestRun'
    | 'replyQuestion'
    | 'replyPermission'
    | 'closeSession'
    | 'abortExecution';
  toolSessionId?: string;
  runId?: string;
}

export interface RuntimeTraceFact {
  type: ProviderFact['type'];
  toolSessionId: string;
  messageId?: string;
}

export interface RuntimeTraceTerminal {
  toolSessionId: string;
  outcome: ProviderTerminalResult['outcome'];
}

export interface RuntimeTraceInteraction {
  action: 'register' | 'consume' | 'clear';
  kind?: 'question' | 'permission';
  toolSessionId: string;
  tokenId?: string;
}

export interface RuntimeTraceFailure {
  kind:
    | 'startup_failure'
    | 'gateway_runtime_failure'
    | 'command_execution_failure'
    | 'inbound_validation_failure'
    | 'outbound_validation_failure';
  phase: 'start' | 'runtime' | 'stop';
  message: string;
  code?: string;
}

export interface RuntimeDiagnostics {
  gatewayState?: string;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  lastHeartbeatAt: number | null;
  providerCalls: RuntimeTraceProviderCall[];
  facts: RuntimeTraceFact[];
  uplinks: Array<{ type: GatewayUplinkBusinessMessage['type']; toolSessionId?: string }>;
  terminals: RuntimeTraceTerminal[];
  interactions: RuntimeTraceInteraction[];
  derivedEvents: Array<{ type: SkillProviderEvent['type']; toolSessionId: string }>;
  failures: RuntimeTraceFailure[];
}

/**
 * 运行时诊断 trace 收集器。
 */
export class RuntimeTraceCollector {
  private readonly diagnostics: RuntimeDiagnostics = {
    gatewayState: undefined,
    lastInboundAt: null,
    lastOutboundAt: null,
    lastHeartbeatAt: null,
    providerCalls: [],
    facts: [],
    uplinks: [],
    terminals: [],
    interactions: [],
    derivedEvents: [],
    failures: [],
  };

  recordProviderCall(call: RuntimeTraceProviderCall): void {
    this.diagnostics.providerCalls.push(call);
  }

  recordFact(fact: ProviderFact): void {
    this.diagnostics.facts.push({
      type: fact.type,
      toolSessionId: fact.toolSessionId,
      ...('messageId' in fact ? { messageId: fact.messageId } : {}),
    });
  }

  recordUplink(message: GatewayUplinkBusinessMessage): void {
    this.diagnostics.uplinks.push({
      type: message.type,
      ...('toolSessionId' in message && message.toolSessionId ? { toolSessionId: message.toolSessionId } : {}),
    });
  }

  recordTerminal(toolSessionId: string, result: ProviderTerminalResult): void {
    this.diagnostics.terminals.push({
      toolSessionId,
      outcome: result.outcome,
    });
  }

  recordInteraction(interaction: RuntimeTraceInteraction): void {
    this.diagnostics.interactions.push(interaction);
  }

  recordDerivedEvent(toolSessionId: string, event: SkillProviderEvent): void {
    this.diagnostics.derivedEvents.push({
      toolSessionId,
      type: event.type,
    });
  }

  recordFailure(failure: RuntimeTraceFailure): void {
    this.diagnostics.failures.push(failure);
  }

  recordGatewayState(state: string): void {
    this.diagnostics.gatewayState = state;
  }

  recordInboundAt(timestamp: number): void {
    this.diagnostics.lastInboundAt = timestamp;
  }

  recordOutboundAt(timestamp: number): void {
    this.diagnostics.lastOutboundAt = timestamp;
  }

  recordHeartbeatAt(timestamp: number): void {
    this.diagnostics.lastHeartbeatAt = timestamp;
  }

  snapshot(): RuntimeDiagnostics {
    return {
      gatewayState: this.diagnostics.gatewayState,
      lastInboundAt: this.diagnostics.lastInboundAt,
      lastOutboundAt: this.diagnostics.lastOutboundAt,
      lastHeartbeatAt: this.diagnostics.lastHeartbeatAt,
      providerCalls: [...this.diagnostics.providerCalls],
      facts: [...this.diagnostics.facts],
      uplinks: [...this.diagnostics.uplinks],
      terminals: [...this.diagnostics.terminals],
      interactions: [...this.diagnostics.interactions],
      derivedEvents: [...this.diagnostics.derivedEvents],
      failures: [...this.diagnostics.failures],
    };
  }
}
