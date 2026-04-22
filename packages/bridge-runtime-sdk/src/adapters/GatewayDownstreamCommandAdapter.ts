import type { GatewayDownstreamBusinessRequest } from '@agent-plugin/gateway-schema';

import type { RuntimeCommand } from '../domain/runtime-command.ts';

/**
 * 网关下行请求到 runtime command 的适配边界。
 */
export function toRuntimeCommand(message: GatewayDownstreamBusinessRequest, traceId: string): RuntimeCommand {
  if (message.type === 'status_query') {
    return { kind: 'query_status', traceId, source: message };
  }

  switch (message.action) {
    case 'create_session':
      return { kind: 'create_session', traceId, source: message };
    case 'chat':
      return { kind: 'start_request_run', traceId, source: message };
    case 'question_reply':
      return { kind: 'reply_question', traceId, source: message };
    case 'permission_reply':
      return { kind: 'reply_permission', traceId, source: message };
    case 'close_session':
      return { kind: 'close_session', traceId, source: message };
    case 'abort_session':
      return { kind: 'abort_execution', traceId, source: message };
  }

  throw new Error(`Unsupported downstream action: ${(message as { action?: string }).action ?? 'unknown'}`);
}
