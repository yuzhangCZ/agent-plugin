import type { GatewayDownstreamBusinessRequest } from '@agent-plugin/gateway-schema';

export type QueryStatusRuntimeCommand = {
  kind: 'query_status';
  traceId: string;
  source: Extract<GatewayDownstreamBusinessRequest, { type: 'status_query' }>;
};

export type CreateSessionRuntimeCommand = {
  kind: 'create_session';
  traceId: string;
  source: Extract<GatewayDownstreamBusinessRequest, { type: 'invoke'; action: 'create_session' }>;
};

export type StartRequestRunRuntimeCommand = {
  kind: 'start_request_run';
  traceId: string;
  source: Extract<GatewayDownstreamBusinessRequest, { type: 'invoke'; action: 'chat' }>;
};

export type ReplyQuestionRuntimeCommand = {
  kind: 'reply_question';
  traceId: string;
  source: Extract<GatewayDownstreamBusinessRequest, { type: 'invoke'; action: 'question_reply' }>;
};

export type ReplyPermissionRuntimeCommand = {
  kind: 'reply_permission';
  traceId: string;
  source: Extract<GatewayDownstreamBusinessRequest, { type: 'invoke'; action: 'permission_reply' }>;
};

export type CloseSessionRuntimeCommand = {
  kind: 'close_session';
  traceId: string;
  source: Extract<GatewayDownstreamBusinessRequest, { type: 'invoke'; action: 'close_session' }>;
};

export type AbortExecutionRuntimeCommand = {
  kind: 'abort_execution';
  traceId: string;
  source: Extract<GatewayDownstreamBusinessRequest, { type: 'invoke'; action: 'abort_session' }>;
};

/**
 * runtime 内部命令闭集。
 */
export type RuntimeCommand =
  | QueryStatusRuntimeCommand
  | CreateSessionRuntimeCommand
  | StartRequestRunRuntimeCommand
  | ReplyQuestionRuntimeCommand
  | ReplyPermissionRuntimeCommand
  | CloseSessionRuntimeCommand
  | AbortExecutionRuntimeCommand;
