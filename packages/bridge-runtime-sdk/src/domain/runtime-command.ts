import type { GatewayDownstreamBusinessRequest } from '@agent-plugin/gateway-schema';

/**
 * runtime 内部命令闭集。
 */
export type RuntimeCommand =
  | {
      kind: 'query_status';
      traceId: string;
      source: Extract<GatewayDownstreamBusinessRequest, { type: 'status_query' }>;
    }
  | {
      kind: 'create_session';
      traceId: string;
      source: Extract<GatewayDownstreamBusinessRequest, { type: 'invoke'; action: 'create_session' }>;
    }
  | {
      kind: 'start_request_run';
      traceId: string;
      source: Extract<GatewayDownstreamBusinessRequest, { type: 'invoke'; action: 'chat' }>;
    }
  | {
      kind: 'reply_question';
      traceId: string;
      source: Extract<GatewayDownstreamBusinessRequest, { type: 'invoke'; action: 'question_reply' }>;
    }
  | {
      kind: 'reply_permission';
      traceId: string;
      source: Extract<GatewayDownstreamBusinessRequest, { type: 'invoke'; action: 'permission_reply' }>;
    }
  | {
      kind: 'close_session';
      traceId: string;
      source: Extract<GatewayDownstreamBusinessRequest, { type: 'invoke'; action: 'close_session' }>;
    }
  | {
      kind: 'abort_execution';
      traceId: string;
      source: Extract<GatewayDownstreamBusinessRequest, { type: 'invoke'; action: 'abort_session' }>;
    };
