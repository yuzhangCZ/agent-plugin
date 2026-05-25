import type { RuntimeCommand } from '../domain/runtime-command.ts';
import type { RuntimeCommandDispatcher as RuntimeCommandDispatcherPort } from './ports/runtime-command-dispatcher.ts';
import type { RuntimeUseCaseMap } from './ports/runtime-usecase.ts';
import type { RuntimeObservation } from './runtime-observation/index.ts';

/**
 * runtime 命令分发器；仅负责路由与 use case 装配。
 */
export class RuntimeCommandDispatcher implements RuntimeCommandDispatcherPort {
  private readonly useCases: RuntimeUseCaseMap;
  private readonly observation: RuntimeObservation;

  constructor(useCases: RuntimeUseCaseMap, observation: RuntimeObservation) {
    this.useCases = useCases;
    this.observation = observation;
  }

  /**
   * 执行单个 runtime command。
   */
  async dispatch(command: RuntimeCommand): Promise<void> {
    const context = {
      welinkSessionId: 'source' in command && 'welinkSessionId' in command.source ? command.source.welinkSessionId : undefined,
      toolSessionId: 'source' in command
        && 'payload' in command.source
        && command.source.payload
        && typeof command.source.payload === 'object'
        && 'toolSessionId' in command.source.payload
        ? (command.source.payload as { toolSessionId?: string }).toolSessionId
        : undefined,
    };
    this.observation.commandDispatched(command.kind, command.traceId, context);
    try {
      await this.useCases[command.kind].execute(command as never);
      this.observation.commandCompleted(command.kind, command.traceId, context);
    } catch (error) {
      this.observation.commandFailed(command.kind, command.traceId, error, undefined, context);
      throw error;
    }
  }
}
