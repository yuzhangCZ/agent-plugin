function withDefault(value, fallback) {
  return value === undefined ? fallback : value;
}

export function createInvokeMessage(overrides = {}) {
  return {
    type: 'invoke',
    welinkSessionId: withDefault(overrides.welinkSessionId, 'wl-default'),
    action: withDefault(overrides.action, 'chat'),
    payload: withDefault(overrides.payload, { toolSessionId: 'tool-default', text: 'hello' }),
    ...overrides,
  };
}

export function createChatInvokeMessage(overrides = {}) {
  return createInvokeMessage({
    welinkSessionId: 'wl-chat',
    action: 'chat',
    payload: { toolSessionId: 'tool-chat', text: 'hello' },
    ...overrides,
  });
}

export function createCreateSessionInvokeMessage(overrides = {}) {
  return createInvokeMessage({
    welinkSessionId: 'wl-create',
    action: 'create_session',
    payload: {},
    ...overrides,
  });
}

export function createCloseSessionInvokeMessage(overrides = {}) {
  return createInvokeMessage({
    welinkSessionId: 'wl-close',
    action: 'close_session',
    payload: { toolSessionId: 'tool-close' },
    ...overrides,
  });
}

export function createAbortSessionInvokeMessage(overrides = {}) {
  return createInvokeMessage({
    welinkSessionId: 'wl-abort',
    action: 'abort_session',
    payload: { toolSessionId: 'tool-abort' },
    ...overrides,
  });
}

export function createStatusQueryMessage(overrides = {}) {
  return {
    type: 'status_query',
    ...overrides,
  };
}

export function createCompatInvalidInvokeStatusQueryMessage(overrides = {}) {
  const welinkSessionId = withDefault(overrides.welinkSessionId, 'wl-invalid-status');
  return createInvokeMessage({
    welinkSessionId,
    action: 'status_query',
    payload: withDefault(overrides.payload, { sessionId: welinkSessionId }),
    ...overrides,
  });
}

export function createPermissionReplyInvokeMessage(overrides = {}) {
  return createInvokeMessage({
    welinkSessionId: 'wl-permission',
    action: 'permission_reply',
    payload: {
      toolSessionId: 'tool-permission',
      permissionId: 'perm-1',
      response: 'once',
    },
    ...overrides,
  });
}

export function createQuestionReplyInvokeMessage(overrides = {}) {
  return createInvokeMessage({
    welinkSessionId: 'wl-question',
    action: 'question_reply',
    payload: {
      toolSessionId: 'tool-question',
      answer: 'ok',
    },
    ...overrides,
  });
}
