import type { SessionCreatedMessage, SlashCommandsResultMessage, StatusResponseMessage } from '@agent-plugin/gateway-schema';
import type { ProviderSlashCommand } from '../../domain/provider.ts';

import { GATEWAY_UPLINK_MESSAGE_TYPE } from '../constants/gateway-messages.ts';
import type { GatewayCommandResultProjector } from './projector.types.ts';

/**
 * 默认命令结果 projector。
 */
export class DefaultGatewayCommandResultProjector implements GatewayCommandResultProjector {
  projectStatus(input: { online: boolean }): StatusResponseMessage {
    return {
      type: GATEWAY_UPLINK_MESSAGE_TYPE.statusResponse,
      opencodeOnline: input.online,
    };
  }

  projectSessionCreated(input: { welinkSessionId: string; toolSessionId: string }): SessionCreatedMessage {
    return {
      type: GATEWAY_UPLINK_MESSAGE_TYPE.sessionCreated,
      welinkSessionId: input.welinkSessionId,
      toolSessionId: input.toolSessionId,
      session: {
        sessionId: input.toolSessionId,
      },
    };
  }

  projectSlashCommands(input: {
    toolSessionId: string;
    traceId: string;
    slashCommands: ProviderSlashCommand[];
  }): SlashCommandsResultMessage {
    return {
      type: GATEWAY_UPLINK_MESSAGE_TYPE.slashCommandsResult,
      toolSessionId: input.toolSessionId,
      traceId: input.traceId,
      payload: {
        slashCommands: input.slashCommands,
      },
    };
  }
}
