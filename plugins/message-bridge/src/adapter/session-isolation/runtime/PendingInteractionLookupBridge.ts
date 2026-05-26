import type {
  AnchorBindingRepository,
  InteractionLookupBridge,
} from '../../../port/session-isolation/index.js';
import type { InteractionLookupResult } from '../../../port/session-isolation/dto/results/index.js';

type PendingInteractionRecord = {
  toolSessionId: string;
  kind: 'question' | 'permission';
  tokenId: string;
};

type PendingInteractionLookupRegistry = {
  consume(input: { kind: 'question' | 'permission'; tokenId: string }): PendingInteractionRecord | undefined;
};

type LegacyQuestionListPort = {
  listQuestions(): Promise<unknown[]>;
};

/**
 * 解析 pending question/permission 与当前 anchor binding 的关系。
 * @remarks registry 是正式路径；question fallback 只兼容 legacy OpenCode request list，避免 slash 切换后误回到新活跃会话。
 */
export class PendingInteractionLookupBridge implements InteractionLookupBridge {
  constructor(private readonly dependencies: {
    pendingInteractionRegistry: PendingInteractionLookupRegistry;
    anchorBindingRepository: AnchorBindingRepository;
    legacyQuestionListPort?: LegacyQuestionListPort;
  }) {}

  async findQuestion(questionId: string): Promise<InteractionLookupResult> {
    const result = await this.find('question', questionId);
    if (result.kind === 'found') {
      return result;
    }

    return this.findQuestionFromLegacyList(questionId);
  }

  async findPermission(permissionId: string): Promise<InteractionLookupResult> {
    return this.find('permission', permissionId);
  }

  private async find(kind: 'question' | 'permission', tokenId: string): Promise<InteractionLookupResult> {
    const interaction = this.dependencies.pendingInteractionRegistry.consume({ kind, tokenId });
    if (!interaction) {
      return { kind: 'missing' };
    }

    const binding = await this.dependencies.anchorBindingRepository.get(interaction.toolSessionId);
    if (!binding?.sessionId || binding.state !== 'attached') {
      return { kind: 'missing' };
    }

    return {
      kind: 'found',
      toolSessionId: interaction.toolSessionId,
      sessionId: binding.sessionId,
    };
  }

  private async findQuestionFromLegacyList(questionId: string): Promise<InteractionLookupResult> {
    const questionListPort = this.dependencies.legacyQuestionListPort;
    if (!questionListPort) {
      return { kind: 'missing' };
    }

    const question = (await questionListPort.listQuestions())
      .map((record) => this.toLegacyQuestionRecord(record))
      .find((record) => record?.id === questionId);
    if (!question?.sessionId) {
      return { kind: 'missing' };
    }

    const [binding] = await this.dependencies.anchorBindingRepository.findBySessionId(question.sessionId);
    if (!binding?.sessionId || binding.state !== 'attached') {
      return { kind: 'missing' };
    }

    return {
      kind: 'found',
      toolSessionId: binding.toolSessionId,
      sessionId: binding.sessionId,
    };
  }

  private toLegacyQuestionRecord(record: unknown): { id: string; sessionId: string } | undefined {
    if (!record || typeof record !== 'object') {
      return undefined;
    }
    const raw = record as { id?: unknown; sessionID?: unknown };
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const sessionId = typeof raw.sessionID === 'string' ? raw.sessionID.trim() : '';
    if (!id || !sessionId) {
      return undefined;
    }
    return { id, sessionId };
  }
}
