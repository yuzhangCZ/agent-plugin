import { DefaultEntryKeyCodec } from '../../../domain/session-isolation/index.js';
import {
  InMemoryOwnedSessionRepository,
  LegacyAnchorBindingRepository,
  LegacyAttachOwnerRepository,
} from '../../../adapter/session-isolation/repository/index.js';
import type {
  OpencodeSessionOwnershipResolver,
  ToolSessionBindingStore,
} from '../../../port/SlashCommandControlPlanePort.js';
import { DefaultOwnedSessionCoordinator } from '../../../usecase/session-isolation/index.js';

/**
 * runtime 侧会话隔离状态写入入口。
 * @remarks
 * 当前仍委托临时态 binding / ownership store；后续正式控制面迁移时只替换这里的依赖。
 */
export class RuntimeSessionIsolationFacade {
  private readonly ownedSessionCoordinator: DefaultOwnedSessionCoordinator;

  constructor(private readonly dependencies: {
    bindingStore: ToolSessionBindingStore;
    ownershipResolver: OpencodeSessionOwnershipResolver;
  }) {
    this.ownedSessionCoordinator = new DefaultOwnedSessionCoordinator({
      akScopeKey: 'runtime-anchor',
      entryKeyCodec: new DefaultEntryKeyCodec(),
      ownedSessionRepository: new InMemoryOwnedSessionRepository(),
      anchorBindingRepository: new LegacyAnchorBindingRepository(dependencies.bindingStore),
      attachOwnerRepository: new LegacyAttachOwnerRepository(dependencies.ownershipResolver),
    });
  }

  async registerCreatedSession(input: { anchor: string; opencodeSessionId: string }): Promise<void> {
    await this.ownedSessionCoordinator.switchAttachedSession({
      toolSessionId: input.anchor,
      sessionId: input.opencodeSessionId,
    });
  }

  async invalidateAfterControlPlaneFailure(anchor: string, error: unknown): Promise<void> {
    const evidence = this.extractEvidence(error);
    if (evidence.sourceErrorCode !== 'session_not_found' && evidence.sourceOperation !== 'session.get') {
      return;
    }

    const binding = this.dependencies.bindingStore.get(anchor);
    if (!binding) {
      return;
    }
    this.dependencies.bindingStore.invalidate(anchor);
    this.dependencies.ownershipResolver.detach(binding.activeOpencodeSessionId);
  }

  private extractEvidence(error: unknown): { sourceOperation?: string; sourceErrorCode?: string } {
    if (typeof error !== 'object' || error === null) {
      return {};
    }
    const evidence = (error as {
      errorEvidence?: { sourceOperation?: unknown; sourceErrorCode?: unknown };
    }).errorEvidence;
    return {
      ...(typeof evidence?.sourceOperation === 'string' ? { sourceOperation: evidence.sourceOperation } : {}),
      ...(typeof evidence?.sourceErrorCode === 'string' ? { sourceErrorCode: evidence.sourceErrorCode } : {}),
    };
  }
}
