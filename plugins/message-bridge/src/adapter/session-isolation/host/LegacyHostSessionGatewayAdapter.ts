import type {
  HostSessionQueryPort,
} from '../../../port/SlashCommandControlPlanePort.js';
import type { SessionCreationPort } from '../../../port/SessionCreationPort.js';
import type { SessionScopedActionGatewayPort } from '../../../port/SessionScopedActionGatewayPort.js';
import type {
  HostPromptInput,
  HostSessionCreateInput,
} from '../../../port/session-isolation/dto/commands/index.js';
import type { HostSessionRecord } from '../../../port/session-isolation/dto/records/index.js';
import type { RuntimeAppliedResult } from '../../../port/session-isolation/dto/results/index.js';
import type { HostSessionGateway } from '../../../port/session-isolation/outbound/index.js';
import type { ActionFailure, ActionResult } from '../../../types/action-runtime.js';

const DIALOG_ONLY_DENY_PERMISSIONS = [
  'bash',
  'read',
  'glob',
  'grep',
  'edit',
  'write',
  'task',
  'webfetch',
  'myAgentWebFetch',
  'meeting*',
  'knowledge*',
  'playwright*',
] as const;

/**
 * 将现有 host/query/action ports 包装成正式 session-isolation HostSessionGateway。
 * @remarks 这里只做接口适配和失败收敛，不依据标题、record 或命名约定反推受控会话策略。
 */
export class LegacyHostSessionGatewayAdapter implements HostSessionGateway {
  constructor(private readonly dependencies: {
    hostSessionQueryPort: HostSessionQueryPort;
    sessionCreationPort: SessionCreationPort;
    sessionScopedActionGatewayPort: SessionScopedActionGatewayPort;
  }) {}

  get(sessionId: string): Promise<HostSessionRecord> {
    return this.dependencies.hostSessionQueryPort.getSession(sessionId);
  }

  list(input: { directory?: string }): Promise<HostSessionRecord[]> {
    return this.dependencies.hostSessionQueryPort.listSessions({
      ...(input.directory ? { directory: input.directory } : {}),
    });
  }

  async create(input: HostSessionCreateInput): Promise<HostSessionRecord> {
    const result = await this.dependencies.sessionCreationPort.createSession({
      ...(input.title ? { title: input.title } : {}),
      ...(input.directory ? { directory: input.directory } : {}),
      ...(input.control.controlled && input.control.permissionProfile === 'dialog_only'
        ? { permission: this.toDialogOnlyPermission() }
        : {}),
    });
    const data = this.unwrap(result);
    return this.toCreatedSessionRecord(data);
  }

  async delete(sessionId: string): Promise<RuntimeAppliedResult> {
    this.unwrap(await this.dependencies.sessionScopedActionGatewayPort.closeSession({ sessionId }));
    return { applied: true };
  }

  async prompt(input: HostPromptInput): Promise<RuntimeAppliedResult> {
    this.unwrap(await this.dependencies.sessionScopedActionGatewayPort.promptSession({
      sessionId: input.sessionId,
      text: input.text,
      ...(input.assistantId ? { agent: input.assistantId } : {}),
    }));
    return { applied: true };
  }

  private unwrap<T>(result: ActionResult<T>): T {
    if (!result.success) {
      const error = new Error(result.errorMessage ?? 'host session gateway operation failed') as Error & ActionFailure;
      error.errorCode = result.errorCode;
      error.errorMessage = result.errorMessage;
      error.errorEvidence = result.errorEvidence;
      throw error;
    }
    if (result.data === undefined) {
      throw new Error('host session gateway operation returned empty data');
    }
    return result.data;
  }

  private toCreatedSessionRecord(data: unknown): HostSessionRecord {
    const record = data && typeof data === 'object'
      ? data as { session?: HostSessionRecord; sessionId?: string }
      : {};
    if (record.session) {
      return record.session;
    }
    if (record.sessionId) {
      return { id: record.sessionId };
    }
    throw new Error('session.create returned invalid session payload');
  }

  private toDialogOnlyPermission(): Array<Record<string, unknown>> {
    return DIALOG_ONLY_DENY_PERMISSIONS.map((permission) => ({
      permission,
      pattern: '*',
      action: 'deny',
    }));
  }
}
