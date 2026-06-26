import type {
  ProviderAbortSessionInput,
  ProviderCloseSessionInput,
  ProviderCreateSessionInput,
  ProviderCreateSessionResult,
  ProviderHealthInput,
  ProviderHealthResult,
  ProviderListSlashCommandsInput,
  ProviderListSlashCommandsResult,
  ProviderPermissionReplyInput,
  ProviderQuestionReplyInput,
  ProviderRun,
  ProviderRunMessageInput,
  ThirdPartyAgentProvider,
} from '../../domain/provider.ts';
import type { ProviderCommandHandlers } from './ProviderCommandHandlers.ts';
import { ProviderResultValidator } from './ProviderResultValidator.ts';

/**
 * 对外 Provider SPI 到内部 handler-style contract 的适配器。
 */
export class ProviderApiAdapter implements ProviderCommandHandlers {
  private readonly provider: ThirdPartyAgentProvider;
  private readonly validator: ProviderResultValidator;

  constructor(provider: ThirdPartyAgentProvider, validator = new ProviderResultValidator()) {
    this.provider = provider;
    this.validator = validator;
  }

  queryStatus(input: ProviderHealthInput): Promise<ProviderHealthResult> {
    return this.provider.health(input);
  }

  createSession(input: ProviderCreateSessionInput): Promise<ProviderCreateSessionResult> {
    return this.provider.createSession(input);
  }

  async listSlashCommands(input: ProviderListSlashCommandsInput): Promise<ProviderListSlashCommandsResult> {
    const result = await this.provider.listSlashCommands(input);
    return this.validator.validateListSlashCommandsResult(result);
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
