import type {
  ProviderCreateSessionResult,
  ProviderHealthResult,
  ProviderRun,
  RuntimeAppliedResult,
} from '../../domain/provider-contract.ts';
import type {
  AbortExecutionRuntimeCommand,
  CloseSessionRuntimeCommand,
  CreateSessionRuntimeCommand,
  QueryStatusRuntimeCommand,
  ReplyPermissionRuntimeCommand,
  ReplyQuestionRuntimeCommand,
  RuntimeCommand,
  StartRequestRunRuntimeCommand,
} from '../../domain/runtime-command.ts';

/**
 * Runtime 命令用例通用边界。
 */
export interface RuntimeUseCase<TCommand extends RuntimeCommand, TResult> {
  execute(command: TCommand): Promise<TResult>;
}

/**
 * 状态查询用例。
 */
export type QueryStatusUseCase = RuntimeUseCase<QueryStatusRuntimeCommand, ProviderHealthResult>;

/**
 * 创建会话用例。
 */
export type CreateSessionUseCase = RuntimeUseCase<CreateSessionRuntimeCommand, ProviderCreateSessionResult>;

/**
 * 启动 request run 用例。
 */
export type StartRequestRunUseCase = RuntimeUseCase<StartRequestRunRuntimeCommand, ProviderRun>;

/**
 * 回复问题用例。
 */
export type ReplyQuestionUseCase = RuntimeUseCase<ReplyQuestionRuntimeCommand, RuntimeAppliedResult>;

/**
 * 回复权限用例。
 */
export type ReplyPermissionUseCase = RuntimeUseCase<ReplyPermissionRuntimeCommand, RuntimeAppliedResult>;

/**
 * 关闭会话用例。
 */
export type CloseSessionUseCase = RuntimeUseCase<CloseSessionRuntimeCommand, RuntimeAppliedResult>;

/**
 * 中止执行用例。
 */
export type AbortExecutionUseCase = RuntimeUseCase<AbortExecutionRuntimeCommand, RuntimeAppliedResult>;
