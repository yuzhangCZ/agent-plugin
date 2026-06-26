export const DOWNSTREAM_MESSAGE_TYPES = ['invoke', 'status_query'] as const;
export type DownstreamMessageType = (typeof DOWNSTREAM_MESSAGE_TYPES)[number];

// todo： INVOKE_ACTIONS声明为对象，聚合所有字段，后续外部仅消费该对象 参考TRANSPORT_UPSTREAM_MESSAGE_TYPES
export const INVOKE_ACTIONS = [
  'chat',
  'create_session',
  'close_session',
  'permission_reply',
  'abort_session',
  'question_reply',
  'query_slash_commands',
] as const;

export type InvokeAction = (typeof INVOKE_ACTIONS)[number];

export const ACTION_NAMES = [...INVOKE_ACTIONS, 'status_query'] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

export const PERMISSION_REPLY_RESPONSES = ['once', 'always', 'reject'] as const;
export type PermissionReplyResponse = (typeof PERMISSION_REPLY_RESPONSES)[number];
