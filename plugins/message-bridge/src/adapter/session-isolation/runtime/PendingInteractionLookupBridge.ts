import type {
  AnchorBindingRepository,
  InteractionLookupBridge,
} from '../../../port/session-isolation/index.js';
import type { InteractionLookupResult } from '../../../port/session-isolation/dto/results/index.js';

type PendingInteractionRecord = {
  toolSessionId: string;
  hostSessionId: string;
  kind: 'question' | 'permission';
  tokenId: string;
};

type PendingInteractionLookupRegistry = {
  consume(input: { kind: 'question' | 'permission'; tokenId: string }): PendingInteractionRecord | undefined;
};

type InternalInteractionLookupResult =
  | InteractionLookupResult
  | { kind: 'invalid' };

/**
 * 解析 pending question/permission 与当前 anchor binding 的关系。
 * @remarks registry 是唯一正式路径；映射缺失或当前 binding 不一致时统一 fail-closed。
 */
export class PendingInteractionLookupBridge implements InteractionLookupBridge {
  constructor(private readonly dependencies: {
    pendingInteractionRegistry: PendingInteractionLookupRegistry;
    anchorBindingRepository: AnchorBindingRepository;
  }) {}

  async findQuestion(questionId: string): Promise<InteractionLookupResult> {
    const result = await this.find('question', questionId);
    return result.kind === 'invalid' ? { kind: 'missing' } : result;
  }

  async findPermission(permissionId: string): Promise<InteractionLookupResult> {
    const result = await this.find('permission', permissionId);
    return result.kind === 'invalid' ? { kind: 'missing' } : result;
  }

  private async find(kind: 'question' | 'permission', tokenId: string): Promise<InternalInteractionLookupResult> {
    const interaction = this.dependencies.pendingInteractionRegistry.consume({ kind, tokenId });
    if (!interaction) {
      return { kind: 'missing' };
    }

    const binding = await this.dependencies.anchorBindingRepository.get(interaction.toolSessionId);
    if (
      !binding?.sessionId
      || binding.state !== 'attached'
      || binding.sessionId !== interaction.hostSessionId
    ) {
      return { kind: 'invalid' };
    }

    return {
      kind: 'found',
      toolSessionId: interaction.toolSessionId,
      sessionId: binding.sessionId,
    };
  }
}
