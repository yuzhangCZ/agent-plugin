import type { EntryKeyCodec } from '../../domain/session-isolation/index.js';
import type {
  CloseOwnedSessionInput,
  CreateOwnedSessionInput,
  SessionDeletedEventInput,
  SwitchAttachedSessionInput,
} from '../../port/session-isolation/dto/commands/index.js';
import type { OwnedSessionMutationResult } from '../../port/session-isolation/dto/results/index.js';
import type {
  AnchorBindingRepository,
  AttachOwnerRepository,
  OwnedSessionRepository,
} from '../../port/session-isolation/index.js';

export interface OwnedSessionCoordinator {
  bindOwnedSession(input: CreateOwnedSessionInput): Promise<OwnedSessionMutationResult>;
  switchAttachedSession(input: SwitchAttachedSessionInput): Promise<OwnedSessionMutationResult>;
  closeOwnedSession(input: CloseOwnedSessionInput): Promise<OwnedSessionMutationResult>;
  reconcileDeletedSession(input: SessionDeletedEventInput): Promise<OwnedSessionMutationResult>;
}

/**
 * ownership / binding / attach owner 的唯一应用层写入协调器。
 */
export class DefaultOwnedSessionCoordinator implements OwnedSessionCoordinator {
  constructor(private readonly dependencies: {
    akScopeKey: string;
    entryKeyCodec: EntryKeyCodec;
    ownedSessionRepository: OwnedSessionRepository;
    anchorBindingRepository: AnchorBindingRepository;
    attachOwnerRepository: AttachOwnerRepository;
  }) {}

  async bindOwnedSession(input: CreateOwnedSessionInput): Promise<OwnedSessionMutationResult> {
    await this.dependencies.ownedSessionRepository.upsert({
      akScopeKey: this.dependencies.akScopeKey,
      entryKey: this.dependencies.entryKeyCodec.stringify(input.entryKey),
      sessionId: input.sessionId,
      controlled: true,
      permissionProfile: 'dialog_only',
    });
    await this.attach(input.toolSessionId, input.sessionId);
    return { applied: true };
  }

  async switchAttachedSession(input: SwitchAttachedSessionInput): Promise<OwnedSessionMutationResult> {
    const existing = await this.dependencies.anchorBindingRepository.get(input.toolSessionId);
    if (existing?.sessionId && existing.sessionId !== input.sessionId) {
      await this.dependencies.attachOwnerRepository.delete(existing.sessionId);
    }
    await this.attach(input.toolSessionId, input.sessionId);
    return { applied: true };
  }

  async closeOwnedSession(input: CloseOwnedSessionInput): Promise<OwnedSessionMutationResult> {
    const binding = await this.dependencies.anchorBindingRepository.get(input.toolSessionId);
    if (!binding?.sessionId) {
      await this.dependencies.anchorBindingRepository.delete(input.toolSessionId);
      return { applied: true };
    }

    await this.cleanupSession(binding.sessionId);
    return { applied: true };
  }

  async reconcileDeletedSession(input: SessionDeletedEventInput): Promise<OwnedSessionMutationResult> {
    await this.cleanupSession(input.sessionId);
    return { applied: true };
  }

  private async attach(toolSessionId: string, sessionId: string): Promise<void> {
    await this.dependencies.anchorBindingRepository.upsert({
      toolSessionId,
      sessionId,
      state: 'attached',
    });
    await this.dependencies.attachOwnerRepository.upsert({
      sessionId,
      toolSessionId,
    });
  }

  private async cleanupSession(sessionId: string): Promise<void> {
    const bindings = await this.dependencies.anchorBindingRepository.findBySessionId(sessionId);
    await Promise.all(bindings.map((binding) => this.dependencies.anchorBindingRepository.delete(binding.toolSessionId)));
    await this.dependencies.attachOwnerRepository.delete(sessionId);
    await this.dependencies.ownedSessionRepository.deleteBySessionId({
      akScopeKey: this.dependencies.akScopeKey,
      sessionId,
    });
  }
}
