import type { RuntimeCommand } from '../../domain/runtime-command.ts';
import type { RuntimeCore, RuntimeCoreOptions } from './runtime-core.types.ts';

/**
 * runtime core 编排服务。
 */
export class RuntimeCoreService implements RuntimeCore {
  private readonly options: RuntimeCoreOptions;
  private initialized = false;

  constructor(options: RuntimeCoreOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.options.provider.initialize?.({
      outbound: {
        emitOutboundMessage: async (input) => {
          return this.options.outboundEmitter.emitOutbound({
            toolSessionId: input.toolSessionId,
            messageId: input.messageId,
            facts: input.facts,
          });
        },
      },
    });
    this.initialized = true;
    this.options.observation.runtimeCoreStarted();
  }

  async stop(): Promise<void> {
    if (!this.initialized) {
      return;
    }
    await this.options.provider.dispose?.();
    this.initialized = false;
    this.options.observation.runtimeCoreStopped();
  }

  async handleCommand(command: RuntimeCommand): Promise<import('../runtime-observation.ts').RuntimeObservationCommand> {
    await this.options.dispatcher.dispatch(command);
    return command.kind;
  }
}
