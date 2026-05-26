import type { EntryKeyCodec } from '../../domain/session-isolation/index.js';
import type { ChatContextQuery } from '../../port/session-isolation/dto/commands/index.js';
import type { ResolvedEntrySessionContext } from '../../port/session-isolation/dto/results/index.js';
import type {
  AnchorBindingRepository,
  HostSessionGateway,
  OwnedSessionRepository,
} from '../../port/session-isolation/outbound/index.js';

export interface ResolveEntrySessionContextUseCase {
  execute(input: ChatContextQuery): Promise<ResolvedEntrySessionContext>;
}

/**
 * 解析业务入口可见的受控宿主会话。
 * @remarks 该 use case 只读 repository / host，不写 ownership，避免解析阶段产生隐式状态副作用。
 */
export class DefaultResolveEntrySessionContextUseCase implements ResolveEntrySessionContextUseCase {
  constructor(private readonly dependencies: {
    akScopeKey: string;
    entryKeyCodec: EntryKeyCodec;
    ownedSessionRepository: OwnedSessionRepository;
    anchorBindingRepository: AnchorBindingRepository;
    hostSessionGateway: HostSessionGateway;
  }) {}

  async execute(input: ChatContextQuery): Promise<ResolvedEntrySessionContext> {
    const entryKey = this.dependencies.entryKeyCodec.stringify(input.entryKey);
    const [ownedRecords, binding, hostVisibleSessions] = await Promise.all([
      this.dependencies.ownedSessionRepository.findByEntryKey({
        akScopeKey: this.dependencies.akScopeKey,
        entryKey,
      }),
      this.dependencies.anchorBindingRepository.get(input.toolSessionId),
      this.dependencies.hostSessionGateway.list({ ...(input.directory ? { directory: input.directory } : {}) }),
    ]);

    const ownedSessionIds = new Set(ownedRecords.map((record) => record.sessionId));
    const visibleSessions = [];
    for (const session of hostVisibleSessions) {
      if (ownedSessionIds.has(session.id)) {
        visibleSessions.push(session);
        continue;
      }
      if (!input.policy.allowOpencodeNativeSessions) {
        continue;
      }
      const ownedRecord = await this.dependencies.ownedSessionRepository.findBySessionId({
        akScopeKey: this.dependencies.akScopeKey,
        sessionId: session.id,
      });
      if (!ownedRecord) {
        visibleSessions.push(session);
      }
    }
    const session = binding?.state === 'attached' && binding.sessionId
      ? visibleSessions.find((candidate) => candidate.id === binding.sessionId)
      : undefined;

    return {
      toolSessionId: input.toolSessionId,
      ...(session ? { session } : {}),
      visibleSessions,
    };
  }
}
