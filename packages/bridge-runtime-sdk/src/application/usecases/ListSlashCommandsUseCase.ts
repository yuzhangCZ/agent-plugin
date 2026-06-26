import type { ProviderCommandHandlers } from '../../adapters/provider/provider-api-adapter.ts';
import type { ProviderSlashCommand } from '../../domain/provider.ts';
import type { RuntimeCommand } from '../../domain/runtime-command.ts';
import type { OutboundSink } from '../ports/outbound-sink.ts';
import type { ListSlashCommandsUseCase as ListSlashCommandsUseCasePort } from '../ports/runtime-usecase.ts';
import type { GatewayCommandResultProjector } from '../projectors/index.ts';
import type { RuntimeObservation } from '../runtime-observation/index.ts';

/**
 * 查询 Provider slash command 列表并投影为 Gateway 上行结果。
 * @remarks Provider 查询失败时返回空数组，保证 UI 候选列表降级而不阻断会话。
 */
export class ListSlashCommandsUseCase implements ListSlashCommandsUseCasePort {
  private readonly handlers: ProviderCommandHandlers;
  private readonly sink: OutboundSink;
  private readonly projector: GatewayCommandResultProjector;
  private readonly observation: RuntimeObservation;

  constructor(
    handlers: ProviderCommandHandlers,
    sink: OutboundSink,
    projector: GatewayCommandResultProjector,
    observation: RuntimeObservation,
  ) {
    this.handlers = handlers;
    this.sink = sink;
    this.projector = projector;
    this.observation = observation;
  }

  async execute(command: Extract<RuntimeCommand, { kind: 'list_slash_commands' }>): Promise<void> {
    const context = {
      toolSessionId: command.source.toolSessionId,
    };
    this.observation.usecaseStarted('list_slash_commands', command.traceId, context);
    let slashCommands: ProviderSlashCommand[] = [];
    try {
      const result = await this.handlers.listSlashCommands({
        traceId: command.traceId,
        ...(command.source.payload?.extParameters !== undefined
          ? { extParameters: command.source.payload.extParameters }
          : {}),
      });
      slashCommands = result.slashCommands;
    } catch (error) {
      this.observation.usecaseFailed('list_slash_commands', command.traceId, error, undefined, context);
    }

    const uplink = this.projector.projectSlashCommands({
      toolSessionId: command.source.toolSessionId,
      traceId: command.source.traceId,
      slashCommands,
    });
    this.observation.uplinkEmitted(uplink);
    await this.sink.send(uplink);
    this.observation.usecaseSucceeded('list_slash_commands', command.traceId, context);
  }
}
