import type { OpencodeSessionGatewayAdapter } from '../../adapter/index.js';
import {
  DefaultSlashCommandReplyPresenter,
} from '../../usecase/index.js';
import type { BridgeLogger } from '../AppLogger.js';
import {
  ChatMessageClassifier,
  SdkChatRunPlanner,
  SdkSlashExecutionUseCase,
} from './SdkChatControlPlane.js';
import {
  SdkChatSlashCommandExecutor,
  type SdkChatSlashCommandExecutorDependencies,
} from './SdkChatSlashCommandExecutor.js';
import type {
  BusinessEntryContextResolver,
} from './session-isolation/index.js';
import { EntryAwareChatSessionResolver } from './session-isolation/index.js';

type EntryAwareChatSessionResolverDependencies = ConstructorParameters<typeof EntryAwareChatSessionResolver>[0];

export interface CreateSdkChatRunPlannerInput {
  slashCommandExecutorDependencies: SdkChatSlashCommandExecutorDependencies;
  businessEntryContextResolver: BusinessEntryContextResolver;
  entryAwareChatSessionResolver: EntryAwareChatSessionResolverDependencies;
  opencodeSessionGatewayAdapter: OpencodeSessionGatewayAdapter;
  logger: BridgeLogger;
  effectiveDirectory?: string;
}

/**
 * 组装 SDK chat run planner。
 * @remarks 将 classifier、native command catalog 和 entry-aware session resolver 的协作收口，
 * 避免 `SdkBridgeRuntime` 直接理解 chat/slash 内部结构。
 */
export function createSdkChatRunPlanner(input: CreateSdkChatRunPlannerInput): SdkChatRunPlanner {
  const slashCommandExecutor = new SdkChatSlashCommandExecutor({
    ...input.slashCommandExecutorDependencies,
    logger: input.logger,
  });
  return new SdkChatRunPlanner({
    chatMessageClassifier: new ChatMessageClassifier({
      listNativeCommands: async (catalogInput) => {
        const result = await input.opencodeSessionGatewayAdapter.listCommandCatalog({
          ...(catalogInput.directory ? { directory: catalogInput.directory } : {}),
          logger: input.logger,
        });
        return result.commands;
      },
    }),
    slashExecutionUseCase: new SdkSlashExecutionUseCase({
      slashCommandExecutor,
      replyPresenter: new DefaultSlashCommandReplyPresenter(),
    }),
    businessEntryContextResolver: input.businessEntryContextResolver,
    effectiveDirectory: input.effectiveDirectory,
    normalChatSessionResolver: new EntryAwareChatSessionResolver(input.entryAwareChatSessionResolver),
  });
}
