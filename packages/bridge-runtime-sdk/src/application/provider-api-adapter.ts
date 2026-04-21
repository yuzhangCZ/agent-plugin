import type {
  ProviderAbortSessionInput,
  ProviderCloseSessionInput,
  ProviderCreateSessionInput,
  ProviderCreateSessionResult,
  ProviderHealthInput,
  ProviderHealthResult,
  ProviderPermissionReplyInput,
  ProviderQuestionReplyInput,
  ProviderRun,
  ProviderRunMessageInput,
  ThirdPartyAgentProvider,
} from '../domain/provider.ts';
import type { RuntimeTraceCollector } from './runtime-trace.ts';

export interface ProviderCommandHandlers {
  queryStatus(input: ProviderHealthInput): Promise<ProviderHealthResult>;
  createSession(input: ProviderCreateSessionInput): Promise<ProviderCreateSessionResult>;
  startRequestRun(input: ProviderRunMessageInput): Promise<ProviderRun>;
  replyQuestion(input: ProviderQuestionReplyInput): Promise<{ applied: true }>;
  replyPermission(input: ProviderPermissionReplyInput): Promise<{ applied: true }>;
  closeSession(input: ProviderCloseSessionInput): Promise<{ applied: true }>;
  abortExecution(input: ProviderAbortSessionInput): Promise<{ applied: true }>;
}

/**
 * 对外 Provider SPI 到内部 handler-style contract 的适配器。
 */
export class ProviderApiAdapter implements ProviderCommandHandlers {
  private readonly provider: ThirdPartyAgentProvider;
  private readonly trace: RuntimeTraceCollector;

  constructor(provider: ThirdPartyAgentProvider, trace: RuntimeTraceCollector) {
    this.provider = provider;
    this.trace = trace;
  }

  queryStatus(input: ProviderHealthInput): Promise<ProviderHealthResult> {
    this.trace.recordProviderCall({ command: 'queryStatus' });
    return this.provider.health(input);
  }

  createSession(input: ProviderCreateSessionInput): Promise<ProviderCreateSessionResult> {
    this.trace.recordProviderCall({ command: 'createSession' });
    return this.provider.createSession(input);
  }

  startRequestRun(input: ProviderRunMessageInput): Promise<ProviderRun> {
    this.trace.recordProviderCall({
      command: 'startRequestRun',
      toolSessionId: input.toolSessionId,
      runId: input.runId,
    });
    return this.provider.runMessage(input);
  }

  replyQuestion(input: ProviderQuestionReplyInput): Promise<{ applied: true }> {
    this.trace.recordProviderCall({
      command: 'replyQuestion',
      toolSessionId: input.toolSessionId,
    });
    return this.provider.replyQuestion(input);
  }

  replyPermission(input: ProviderPermissionReplyInput): Promise<{ applied: true }> {
    this.trace.recordProviderCall({
      command: 'replyPermission',
      toolSessionId: input.toolSessionId,
    });
    return this.provider.replyPermission(input);
  }

  closeSession(input: ProviderCloseSessionInput): Promise<{ applied: true }> {
    this.trace.recordProviderCall({
      command: 'closeSession',
      toolSessionId: input.toolSessionId,
    });
    return this.provider.closeSession(input);
  }

  abortExecution(input: ProviderAbortSessionInput): Promise<{ applied: true }> {
    this.trace.recordProviderCall({
      command: 'abortExecution',
      toolSessionId: input.toolSessionId,
      runId: input.runId,
    });
    return this.provider.abortSession(input);
  }
}
