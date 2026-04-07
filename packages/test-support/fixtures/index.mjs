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

export function createGatewayWireCreateSessionInvokeMessage(overrides = {}) {
  return createInvokeMessage({
    welinkSessionId: 'wl-gateway-create',
    action: 'create_session',
    payload: { title: 'gateway-wire session', assistantId: 'persona-gateway' },
    ...overrides,
  });
}

export function createGatewayWireLegacyCreateSessionInvokeMessage(overrides = {}) {
  return createInvokeMessage({
    welinkSessionId: 'wl-gateway-legacy-create',
    action: 'create_session',
    payload: { sessionId: 'legacy-session-id', metadata: { source: 'legacy-openclaw' } },
    ...overrides,
  });
}

export function createGatewayWireMessageUpdatedEvent(overrides = {}) {
  return {
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-gateway-wire',
        sessionID: 'tool-gateway-wire',
        role: 'assistant',
        time: {
          created: 1234567890,
        },
        model: {
          provider: 'openai',
          name: 'gpt-5',
        },
        summary: {
          additions: 12,
          deletions: 3,
          files: 2,
          diffs: [
            {
              file: 'src/index.ts',
              status: 'modified',
              additions: 10,
              deletions: 2,
            },
          ],
        },
      },
    },
    ...overrides,
  };
}

export function createGatewayWireMessagePartUpdatedEvent(overrides = {}) {
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-gateway-wire',
        sessionID: 'tool-gateway-wire',
        messageID: 'msg-gateway-wire',
        type: 'text',
        text: 'hello',
        tool: 'search',
        callID: 'call-gateway-wire',
        state: {
          status: 'running',
        },
      },
    },
    ...overrides,
  };
}

export function createGatewayWireMessagePartUpdatedToolEvent(overrides = {}) {
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-gateway-wire-tool',
        sessionID: 'tool-gateway-wire',
        messageID: 'msg-gateway-wire-tool',
        type: 'tool',
        tool: 'search',
        callID: 'call-gateway-wire-tool',
        state: {
          status: 'completed',
          output: {
            total: 3,
            nested: {
              ok: true,
            },
          },
          error: 'tool failed',
          title: 'Search results',
        },
      },
    },
    ...overrides,
  };
}

export function createGatewayWireMessagePartDeltaEvent(overrides = {}) {
  return {
    type: 'message.part.delta',
    properties: {
      sessionID: 'tool-gateway-wire',
      messageID: 'msg-gateway-wire',
      partID: 'part-gateway-wire',
      field: 'text',
      delta: 'he',
    },
    ...overrides,
  };
}

export function createGatewayWireMessagePartRemovedEvent(overrides = {}) {
  return {
    type: 'message.part.removed',
    properties: {
      sessionID: 'tool-gateway-wire',
      messageID: 'msg-gateway-wire',
      partID: 'part-gateway-wire',
    },
    ...overrides,
  };
}

export function createGatewayWireSessionStatusEvent(overrides = {}) {
  return {
    type: 'session.status',
    properties: {
      sessionID: 'tool-gateway-wire',
      status: {
        type: 'busy',
      },
    },
    ...overrides,
  };
}

export function createGatewayWireSessionIdleEvent(overrides = {}) {
  return {
    type: 'session.idle',
    properties: {
      sessionID: 'tool-gateway-wire',
    },
    ...overrides,
  };
}

export function createGatewayWireSessionUpdatedEvent(overrides = {}) {
  return {
    type: 'session.updated',
    properties: {
      info: {
        id: 'tool-gateway-wire',
      },
    },
    ...overrides,
  };
}

export function createGatewayWireSessionErrorEvent(overrides = {}) {
  return {
    type: 'session.error',
    properties: {
      sessionID: 'tool-gateway-wire',
      error: {
        message: 'boom',
      },
    },
    ...overrides,
  };
}

export function createGatewayWirePermissionUpdatedEvent(overrides = {}) {
  return {
    type: 'permission.updated',
    properties: {
      sessionID: 'tool-gateway-wire',
      id: 'perm-gateway-wire',
      status: 'granted',
    },
    ...overrides,
  };
}

export function createGatewayWirePermissionAskedEvent(overrides = {}) {
  return {
    type: 'permission.asked',
    properties: {
      sessionID: 'tool-gateway-wire',
      id: 'perm-gateway-wire',
      messageID: 'msg-gateway-wire',
      type: 'permission',
      title: 'Need approval',
      metadata: {
        source: 'test',
      },
    },
    ...overrides,
  };
}

export function createGatewayWireQuestionAskedEvent(overrides = {}) {
  return {
    type: 'question.asked',
    properties: {
      sessionID: 'tool-gateway-wire',
      id: 'question-gateway-wire',
      questions: [
        {
          question: 'Proceed?',
          header: 'Confirm',
          options: [
            {
              label: 'Yes',
            },
          ],
        },
      ],
      tool: {
        messageID: 'msg-gateway-wire',
        callID: 'call-gateway-wire',
      },
    },
    ...overrides,
  };
}

export const GATEWAY_WIRE_TOOL_EVENT_FIXTURES = [
  { type: 'message.updated', build: createGatewayWireMessageUpdatedEvent },
  { type: 'message.part.updated', build: createGatewayWireMessagePartUpdatedEvent },
  { type: 'message.part.delta', build: createGatewayWireMessagePartDeltaEvent },
  { type: 'message.part.removed', build: createGatewayWireMessagePartRemovedEvent },
  { type: 'session.status', build: createGatewayWireSessionStatusEvent },
  { type: 'session.idle', build: createGatewayWireSessionIdleEvent },
  { type: 'session.updated', build: createGatewayWireSessionUpdatedEvent },
  { type: 'session.error', build: createGatewayWireSessionErrorEvent },
  { type: 'permission.updated', build: createGatewayWirePermissionUpdatedEvent },
  { type: 'permission.asked', build: createGatewayWirePermissionAskedEvent },
  { type: 'question.asked', build: createGatewayWireQuestionAskedEvent },
];

export const GATEWAY_WIRE_SIMPLE_TOOL_EVENT_FIXTURES = [
  { type: 'message.part.delta', build: createGatewayWireMessagePartDeltaEvent },
  { type: 'message.part.removed', build: createGatewayWireMessagePartRemovedEvent },
  { type: 'session.status', build: createGatewayWireSessionStatusEvent },
  { type: 'session.idle', build: createGatewayWireSessionIdleEvent },
  { type: 'session.updated', build: createGatewayWireSessionUpdatedEvent },
  { type: 'session.error', build: createGatewayWireSessionErrorEvent },
  { type: 'permission.updated', build: createGatewayWirePermissionUpdatedEvent },
  { type: 'permission.asked', build: createGatewayWirePermissionAskedEvent },
  { type: 'question.asked', build: createGatewayWireQuestionAskedEvent },
];

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
