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
} from '../../domain/provider.ts';

export interface ProviderCommandHandlers {
  queryStatus(input: ProviderHealthInput): Promise<ProviderHealthResult>;
  createSession(input: ProviderCreateSessionInput): Promise<ProviderCreateSessionResult>;
  listSlashCommands(input: ProviderListSlashCommandsInput): Promise<ProviderListSlashCommandsResult>;
  startRequestRun(input: ProviderRunMessageInput): Promise<ProviderRun>;
  replyQuestion(input: ProviderQuestionReplyInput): Promise<{ applied: true }>;
  replyPermission(input: ProviderPermissionReplyInput): Promise<{ applied: true }>;
  closeSession(input: ProviderCloseSessionInput): Promise<{ applied: true }>;
  abortExecution(input: ProviderAbortSessionInput): Promise<{ applied: true }>;
}
