import type { BridgeEvent } from '../../runtime/types.js';
import type { SessionDeletedEventInput } from '../../port/session-isolation/dto/commands/index.js';
import type {
  HostEventHandleResult,
  OwnedSessionMutationResult,
} from '../../port/session-isolation/dto/results/index.js';
import type { HostEventPort } from '../../port/session-isolation/inbound/index.js';
import type { OwnedHostEventForwarder } from '../../port/session-isolation/outbound/index.js';
import type {
  EventOwnershipResolver,
  EventSessionLocator,
  SessionDeletedEventHandler,
} from '../../adapter/session-isolation/event/index.js';

export interface SessionDeletedReconcileUseCase {
  execute(input: SessionDeletedEventInput): Promise<OwnedSessionMutationResult>;
}

/**
 * 宿主事件进入会话隔离控制面的应用层入口。
 * @remarks 普通事件只允许 owned 分支转发；删除事件单独走 reconcile，避免隐式复用 forward 分支。
 */
export class DefaultHostEventUseCase implements HostEventPort {
  constructor(private readonly dependencies: {
    eventSessionLocator: EventSessionLocator;
    eventOwnershipResolver: EventOwnershipResolver;
    ownedHostEventForwarder: OwnedHostEventForwarder;
    sessionDeletedEventHandler: SessionDeletedEventHandler;
    sessionDeletedReconcileUseCase: SessionDeletedReconcileUseCase;
  }) {}

  async handle(event: BridgeEvent): Promise<HostEventHandleResult> {
    const deletedInput = this.dependencies.sessionDeletedEventHandler.toInput(event);
    if (deletedInput) {
      await this.dependencies.sessionDeletedReconcileUseCase.execute(deletedInput);
      return { kind: 'reconciled', sessionId: deletedInput.sessionId };
    }

    const rawSessionId = this.dependencies.eventSessionLocator.locate(event);
    if (!rawSessionId) {
      return { kind: 'dropped', reason: 'unsupported_event' };
    }

    const ownership = await this.dependencies.eventOwnershipResolver.resolve(rawSessionId);
    if (ownership.kind !== 'owned') {
      return { kind: 'ignored', reason: 'unowned_event' };
    }

    await this.dependencies.ownedHostEventForwarder.forward({
      toolSessionId: ownership.toolSessionId,
      event,
    });
    return { kind: 'forwarded', toolSessionId: ownership.toolSessionId };
  }
}
