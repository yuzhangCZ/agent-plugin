import type { ThirdPartyAgentProvider } from '../../domain/provider.ts';
import type { RuntimeCommand } from '../../domain/runtime-command.ts';
import type { RuntimeCommandDispatcher } from '../ports/runtime-command-dispatcher.ts';
import type { RuntimeObservation, RuntimeObservationCommand } from '../runtime-observation/index.ts';

export interface RuntimeOutboundEmitter {
  emitOutbound(input: {
    toolSessionId: string;
    messageId: string;
    facts: AsyncIterable<import('../../domain/provider.ts').ProviderFact>;
  }): Promise<{ applied: true }>;
}

export interface RuntimeCoreOptions {
  provider: ThirdPartyAgentProvider;
  dispatcher: RuntimeCommandDispatcher;
  outboundEmitter: RuntimeOutboundEmitter;
  traceIdFactory?: () => string;
  observation: RuntimeObservation;
}

export interface RuntimeCore {
  start(): Promise<void>;
  stop(): Promise<void>;
  handleCommand(command: RuntimeCommand): Promise<RuntimeObservationCommand>;
}
