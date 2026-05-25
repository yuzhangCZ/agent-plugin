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
} from '../../domain/provider.ts';
import type { ProviderCommandHandlers } from './ProviderCommandHandlers.ts';

/**
 * 对外 Provider SPI 到内部 handler-style contract 的适配器。
 */
export class ProviderApiAdapter implements ProviderCommandHandlers {
  private readonly provider: ThirdPartyAgentProvider;

  constructor(provider: ThirdPartyAgentProvider) {
    this.provider = provider;
  }

  queryStatus(input: ProviderHealthInput): Promise<ProviderHealthResult> {
    return this.provider.health(input);
  }

  createSession(input: ProviderCreateSessionInput): Promise<ProviderCreateSessionResult> {
    return this.provider.createSession(input);
  }

  startRequestRun(input: ProviderRunMessageInput): Promise<ProviderRun> {
    return this.provider.runMessage(input);
  }

  replyQuestion(input: ProviderQuestionReplyInput): Promise<{ applied: true }> {
    return this.provider.replyQuestion(input);
  }

  replyPermission(input: ProviderPermissionReplyInput): Promise<{ applied: true }> {
    return this.provider.replyPermission(input);
  }

  closeSession(input: ProviderCloseSessionInput): Promise<{ applied: true }> {
    return this.provider.closeSession(input);
  }

  abortExecution(input: ProviderAbortSessionInput): Promise<{ applied: true }> {
    return this.provider.abortSession(input);
  }
}
