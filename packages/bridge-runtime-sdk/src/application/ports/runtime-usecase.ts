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
 * @remarks application use case 只负责消费命令并完成副作用，不向调度器暴露 provider 原始结果。
 */
export interface RuntimeUseCase<TCommand extends RuntimeCommand = RuntimeCommand> {
  execute(command: TCommand): Promise<void>;
}

/**
 * 状态查询用例。
 */
export type QueryStatusUseCase = RuntimeUseCase<QueryStatusRuntimeCommand>;

/**
 * 创建会话用例。
 */
export type CreateSessionUseCase = RuntimeUseCase<CreateSessionRuntimeCommand>;

/**
 * 启动 request run 用例。
 */
export type StartRequestRunUseCase = RuntimeUseCase<StartRequestRunRuntimeCommand>;

/**
 * 回复问题用例。
 */
export type ReplyQuestionUseCase = RuntimeUseCase<ReplyQuestionRuntimeCommand>;

/**
 * 回复权限用例。
 */
export type ReplyPermissionUseCase = RuntimeUseCase<ReplyPermissionRuntimeCommand>;

/**
 * 关闭会话用例。
 */
export type CloseSessionUseCase = RuntimeUseCase<CloseSessionRuntimeCommand>;

/**
 * 中止执行用例。
 */
export type AbortExecutionUseCase = RuntimeUseCase<AbortExecutionRuntimeCommand>;

/**
 * dispatcher 装配所需的 use case 映射。
 */
export interface RuntimeUseCaseMap {
  query_status: QueryStatusUseCase;
  create_session: CreateSessionUseCase;
  start_request_run: StartRequestRunUseCase;
  reply_question: ReplyQuestionUseCase;
  reply_permission: ReplyPermissionUseCase;
  close_session: CloseSessionUseCase;
  abort_execution: AbortExecutionUseCase;
}
