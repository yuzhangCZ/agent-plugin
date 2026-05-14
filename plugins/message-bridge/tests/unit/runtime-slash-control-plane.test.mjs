import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { BridgeRuntime } from '../../src/runtime/BridgeRuntime.ts';
import { EventFilter } from '../../src/event/EventFilter.ts';
import { setRuntimeGatewayState } from '../helpers/mock-gateway.mjs';

function assertSyntheticAssistantReply(sent, index, toolSessionId, expectedText) {
  assert.strictEqual(sent[index].type, 'tool_event');
  assert.strictEqual(sent[index].toolSessionId, toolSessionId);
  assert.strictEqual(sent[index].event.type, 'message.updated');
  assert.strictEqual(sent[index].event.properties.info.role, 'assistant');

  const messageId = sent[index].event.properties.info.id;
  assert.match(messageId, /^msg_[a-f0-9]{32}$/);

  const stepStart = sent[index + 1];
  const text = sent[index + 2];
  const stepFinish = sent[index + 3];

  assert.strictEqual(stepStart.event.properties.part.type, 'step-start');
  assert.strictEqual(stepStart.event.properties.part.messageID, messageId);
  assert.strictEqual(text.event.properties.part.type, 'text');
  assert.strictEqual(text.event.properties.part.messageID, messageId);
  assert.strictEqual(text.event.properties.part.text, expectedText);
  assert.strictEqual(stepFinish.event.properties.part.type, 'step-finish');
  assert.strictEqual(stepFinish.event.properties.part.messageID, messageId);
}

function createRuntimeClient(overrides = {}) {
  const base = {
    global: {},
    session: {
      create: async () => ({ data: { id: 'ses-created', title: 'created', directory: '/tmp/ses-created' } }),
      get: async (options) => ({
        data: {
          id: options?.path?.id ?? 'ses-default',
          directory: '/session/default-directory',
        },
      }),
      list: async () => ({ data: [] }),
      abort: async () => ({}),
      delete: async () => ({}),
      prompt: async () => ({ data: { ok: true } }),
    },
    config: {
      providers: async () => ({ data: { providers: [] } }),
    },
    postSessionIdPermissionsPermissionId: async () => ({ data: true }),
    _client: {
      get: async () => ({ data: [] }),
      post: async () => ({ data: undefined }),
    },
  };

  const merged = {
    ...base,
    ...overrides,
    session: {
      ...base.session,
      ...(overrides.session ?? {}),
    },
    config: {
      ...base.config,
      ...(overrides.config ?? {}),
    },
    _client: {
      ...base._client,
      ...(overrides._client ?? {}),
    },
  };

  if (!Object.prototype.hasOwnProperty.call(overrides.session ?? {}, 'list')) {
    merged.session.list = async (options) => merged._client.get({
      url: '/session',
      ...(options?.query?.directory ? { query: { directory: options.query.directory } } : {}),
    });
  }

  if (!Object.prototype.hasOwnProperty.call(overrides.config ?? {}, 'providers')) {
    merged.config.providers = async (options) => merged._client.get({
      url: '/config/providers',
      ...(options?.query?.directory ? { query: { directory: options.query.directory } } : {}),
    });
  }

  if (!Object.prototype.hasOwnProperty.call(overrides, 'postSessionIdPermissionsPermissionId')) {
    merged.postSessionIdPermissionsPermissionId = async (options) => merged._client.post(options);
  }

  return merged;
}

describe('runtime slash control-plane', () => {
  test('chat bootstraps host session before prompt and keeps tool_done envelope anchored to toolSessionId', async () => {
    const creates = [];
    const prompts = [];
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        session: {
          create: async (options) => {
            creates.push(options);
            return {
              data: {
                id: 'ses-bootstrap-1',
                title: 'bootstrap-1',
                directory: '/tmp/bootstrap-1',
              },
            };
          },
          get: async (options) => ({
            data: {
              id: options?.path?.id ?? 'unknown',
              directory: '/tmp/bootstrap-1',
            },
          }),
          prompt: async (options) => {
            prompts.push(options);
            return { data: { ok: true } };
          },
        },
      }),
    });

    const sent = [];
    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-1',
      action: 'chat',
      payload: { toolSessionId: 'tool-1', text: 'hello' },
    });

    assert.strictEqual(creates.length, 1);
    assert.deepStrictEqual(prompts, [
      {
        path: { id: 'ses-bootstrap-1' },
        query: { directory: '/tmp/bootstrap-1' },
        body: {
          parts: [{ type: 'text', text: 'hello' }],
        },
      },
    ]);
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(sent[0], {
      type: 'tool_done',
      toolSessionId: 'tool-1',
      welinkSessionId: 'wl-1',
    });
  });

  test('upstream event only forwards when opencode session is attached to an anchor', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        session: {
          create: async () => ({
            data: {
              id: 'ses-bootstrap-2',
              title: 'bootstrap-2',
              directory: '/tmp/bootstrap-2',
            },
          }),
          get: async (options) => ({
            data: {
              id: options?.path?.id ?? 'unknown',
              directory: '/tmp/bootstrap-2',
            },
          }),
        },
      }),
    });
    const sent = [];

    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    runtime.eventFilter = new EventFilter(['message.updated']);
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg-orphan',
          sessionID: 'ses-orphan',
          role: 'assistant',
          time: { created: 1710000000000 },
        },
      },
    });

    assert.strictEqual(sent.length, 0);

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-2',
      action: 'chat',
      payload: { toolSessionId: 'tool-2', text: 'hello' },
    });

    await runtime.handleEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg-bound',
          sessionID: 'ses-bootstrap-2',
          role: 'assistant',
          time: { created: 1710000000001 },
        },
      },
    });

    assert.strictEqual(sent.length, 2);
    assert.strictEqual(sent[1].type, 'tool_event');
    assert.strictEqual(sent[1].toolSessionId, 'tool-2');
    assert.strictEqual(sent[1].event.properties.info.sessionID, 'ses-bootstrap-2');
  });

  test('slash sessions queries scoped host sessions and returns markdown list', async () => {
    const getCalls = [];
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        session: {
          create: async () => ({
            data: {
              id: 'ses-scope-1',
              title: 'scope-1',
              directory: '/tmp/proj-1',
              projectID: 'proj-1',
              workspaceID: 'ws-1',
            },
          }),
          get: async (options) => ({
            data: {
              id: options?.path?.id ?? 'ses-scope-1',
              title: 'scope-1',
              directory: '/tmp/proj-1',
              projectID: 'proj-1',
              workspaceID: 'ws-1',
            },
          }),
        },
        _client: {
          get: async (options) => {
            getCalls.push(options);
            if (options?.url === '/session') {
              return {
                data: [
                  { id: 'ses-scope-1', title: '当前会话', directory: '/tmp/proj-1', projectID: 'proj-1', workspaceID: 'ws-1' },
                  { id: 'ses-scope-2', title: '第二个会话', directory: '/tmp/proj-1', projectID: 'proj-1', workspaceID: 'ws-1' },
                ],
              };
            }
            return { data: [] };
          },
        },
      }),
    });
    const sent = [];

    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-sessions',
      action: 'chat',
      payload: { toolSessionId: 'tool-sessions', text: '/sessions' },
    });

    assert.deepStrictEqual(getCalls, [
      {
        url: '/session',
        query: {
          directory: '/tmp/proj-1',
        },
      },
    ]);
    assert.strictEqual(sent.length, 5);
    assertSyntheticAssistantReply(
      sent,
      0,
      'tool-sessions',
      '可切换会话列表\n\n- `ses-scope-1` 当前会话（当前）\n- `ses-scope-2` 第二个会话',
    );
    assert.deepStrictEqual(sent[4], { type: 'tool_done', toolSessionId: 'tool-sessions' });
  });

  test('slash session out of scope returns fixed failure text without changing binding', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        session: {
          create: async () => ({
            data: {
              id: 'ses-scope-1',
              title: 'scope-1',
              directory: '/tmp/proj-1',
              projectID: 'proj-1',
              workspaceID: 'ws-1',
            },
          }),
          get: async (options) => {
            if (options?.path?.id === 'ses-scope-2') {
              return {
                data: {
                  id: 'ses-scope-2',
                  title: '越界会话',
                  directory: '/tmp/proj-2',
                  projectID: 'proj-2',
                  workspaceID: 'ws-2',
                },
              };
            }
            return {
              data: {
                id: options?.path?.id ?? 'ses-scope-1',
                title: 'scope-1',
                directory: '/tmp/proj-1',
                projectID: 'proj-1',
                workspaceID: 'ws-1',
              },
            };
          },
        },
      }),
    });
    const sent = [];

    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-session-fail',
      action: 'chat',
      payload: { toolSessionId: 'tool-session-fail', text: '/session ses-scope-2' },
    });

    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(sent[0], {
      type: 'tool_error',
      toolSessionId: 'tool-session-fail',
      error: '切换会话失败, 目标会话不在当前 project/workspace 可切换范围内',
    });
    assert.deepStrictEqual(runtime.bindingStore.get('tool-session-fail'), {
      anchor: 'tool-session-fail',
      activeOpencodeSessionId: 'ses-scope-1',
      status: 'active',
    });
  });

  test('slash session success rebinds anchor and later chat prompts the switched host session', async () => {
    const prompts = [];
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        session: {
          create: async () => ({
            data: {
              id: 'ses-switch-1',
              title: '切换前会话',
              directory: '/tmp/proj-switch',
              projectID: 'proj-switch',
              workspaceID: 'ws-switch',
            },
          }),
          get: async (options) => {
            if (options?.path?.id === 'ses-switch-2') {
              return {
                data: {
                  id: 'ses-switch-2',
                  title: '切换后会话',
                  directory: '/tmp/proj-switch',
                  projectID: 'proj-switch',
                  workspaceID: 'ws-switch',
                },
              };
            }
            return {
              data: {
                id: options?.path?.id ?? 'ses-switch-1',
                title: '切换前会话',
                directory: '/tmp/proj-switch',
                projectID: 'proj-switch',
                workspaceID: 'ws-switch',
              },
            };
          },
          prompt: async (options) => {
            prompts.push(options);
            return { data: { ok: true } };
          },
        },
        _client: {
          get: async (options) => {
            if (options?.url === '/session') {
              return {
                data: [
                  { id: 'ses-switch-1', title: '切换前会话', directory: '/tmp/proj-switch', projectID: 'proj-switch', workspaceID: 'ws-switch' },
                  { id: 'ses-switch-2', title: '切换后会话', directory: '/tmp/proj-switch', projectID: 'proj-switch', workspaceID: 'ws-switch' },
                ],
              };
            }
            return { data: [] };
          },
        },
      }),
    });
    const sent = [];

    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-session-ok-1',
      action: 'chat',
      payload: { toolSessionId: 'tool-session-ok', text: '/session ses-switch-2' },
    });
    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-session-ok-2',
      action: 'chat',
      payload: { toolSessionId: 'tool-session-ok', text: 'after switch' },
    });

    assertSyntheticAssistantReply(sent, 0, 'tool-session-ok', '已切换会话 `ses-switch-2` 切换后会话');
    assert.deepStrictEqual(runtime.bindingStore.get('tool-session-ok'), {
      anchor: 'tool-session-ok',
      activeOpencodeSessionId: 'ses-switch-2',
      status: 'active',
    });
    assert.strictEqual(runtime.ownershipResolver.resolveAttachedAnchor('ses-switch-1'), undefined);
    assert.strictEqual(runtime.ownershipResolver.resolveAttachedAnchor('ses-switch-2'), 'tool-session-ok');
    assert.deepStrictEqual(prompts, [
      {
        path: { id: 'ses-switch-2' },
        query: { directory: '/tmp/proj-switch' },
        body: {
          parts: [{ type: 'text', text: 'after switch' }],
        },
      },
    ]);
  });

  test('slash session delivery failure stays local and does not emit tool_error while keeping committed binding', async () => {
    const prompts = [];
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        session: {
          create: async () => ({
            data: {
              id: 'ses-switch-local-1',
              title: '切换前会话',
              directory: '/tmp/proj-switch-local',
              projectID: 'proj-switch-local',
              workspaceID: 'ws-switch-local',
            },
          }),
          get: async (options) => {
            if (options?.path?.id === 'ses-switch-local-2') {
              return {
                data: {
                  id: 'ses-switch-local-2',
                  title: '切换后会话',
                  directory: '/tmp/proj-switch-local',
                  projectID: 'proj-switch-local',
                  workspaceID: 'ws-switch-local',
                },
              };
            }
            return {
              data: {
                id: options?.path?.id ?? 'ses-switch-local-1',
                title: '切换前会话',
                directory: '/tmp/proj-switch-local',
                projectID: 'proj-switch-local',
                workspaceID: 'ws-switch-local',
              },
            };
          },
          prompt: async (options) => {
            prompts.push(options);
            return { data: { ok: true } };
          },
        },
        _client: {
          get: async (options) => {
            if (options?.url === '/session') {
              return {
                data: [
                  { id: 'ses-switch-local-1', title: '切换前会话', directory: '/tmp/proj-switch-local', projectID: 'proj-switch-local', workspaceID: 'ws-switch-local' },
                  { id: 'ses-switch-local-2', title: '切换后会话', directory: '/tmp/proj-switch-local', projectID: 'proj-switch-local', workspaceID: 'ws-switch-local' },
                ],
              };
            }
            return { data: [] };
          },
        },
      }),
    });
    const sent = [];

    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    setRuntimeGatewayState(runtime, 'READY');

    const originalSessionSender = runtime.sessionSender;
    runtime.sessionSender = {
      sendIfActive: () => false,
    };

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-session-local-1',
      action: 'chat',
      payload: { toolSessionId: 'tool-session-local', text: '/session ses-switch-local-2' },
    });

    runtime.sessionSender = originalSessionSender;

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-session-local-2',
      action: 'chat',
      payload: { toolSessionId: 'tool-session-local', text: 'after switch' },
    });

    assert.strictEqual(sent.some((message) => message.type === 'tool_error'), false);
    assert.deepStrictEqual(runtime.bindingStore.get('tool-session-local'), {
      anchor: 'tool-session-local',
      activeOpencodeSessionId: 'ses-switch-local-2',
      status: 'active',
    });
    assert.strictEqual(runtime.ownershipResolver.resolveAttachedAnchor('ses-switch-local-1'), undefined);
    assert.strictEqual(runtime.ownershipResolver.resolveAttachedAnchor('ses-switch-local-2'), 'tool-session-local');
    assert.deepStrictEqual(prompts, [
      {
        path: { id: 'ses-switch-local-2' },
        query: { directory: '/tmp/proj-switch-local' },
        body: {
          parts: [{ type: 'text', text: 'after switch' }],
        },
      },
    ]);
    assert.deepStrictEqual(sent, [
      {
        type: 'tool_done',
        toolSessionId: 'tool-session-local',
        welinkSessionId: 'wl-session-local-2',
      },
    ]);
  });

  test('slash models bootstraps first and returns provider/model markdown list', async () => {
    const getCalls = [];
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        session: {
          create: async () => ({
            data: {
              id: 'ses-models-1',
              title: '模型目录会话',
              directory: '/tmp/models-1',
              projectID: 'proj-models-1',
              workspaceID: 'ws-models-1',
            },
          }),
          get: async (options) => ({
            data: {
              id: options?.path?.id ?? 'ses-models-1',
              title: '模型目录会话',
              directory: '/tmp/models-1',
              projectID: 'proj-models-1',
              workspaceID: 'ws-models-1',
            },
          }),
        },
        _client: {
          get: async (options) => {
            getCalls.push(options);
            if (options?.url === '/config/providers') {
              return {
                data: {
                  providers: [
                    {
                      id: 'openai',
                      models: {
                        'gpt-5.4': { id: 'gpt-5.4' },
                        'gpt-5.5': { id: 'gpt-5.5' },
                      },
                    },
                    {
                      id: 'anthropic',
                      models: {
                        'claude-sonnet-4.5': { id: 'claude-sonnet-4.5' },
                      },
                    },
                  ],
                },
              };
            }
            return { data: [] };
          },
        },
      }),
    });
    const sent = [];

    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-models',
      action: 'chat',
      payload: { toolSessionId: 'tool-models', text: '/models' },
    });

    assert.strictEqual(sent.length, 5);
    assertSyntheticAssistantReply(
      sent,
      0,
      'tool-models',
      '可用模型列表\n\n- `openai/gpt-5.4`\n- `openai/gpt-5.5`\n- `anthropic/claude-sonnet-4.5`',
    );
    assert.deepStrictEqual(getCalls, [
      {
        url: '/config/providers',
      },
    ]);
    assert.deepStrictEqual(sent[4], { type: 'tool_done', toolSessionId: 'tool-models' });
    assert.deepStrictEqual(runtime.bindingStore.get('tool-models'), {
      anchor: 'tool-models',
      activeOpencodeSessionId: 'ses-models-1',
      status: 'active',
    });
  });

  test('slash sessions failure uses unified template and does not expose raw host error', async () => {
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        session: {
          create: async () => ({
            data: {
              id: 'ses-fail-1',
              title: '列表失败会话',
              directory: '/tmp/fail-1',
              projectID: 'proj-fail',
              workspaceID: 'ws-fail',
            },
          }),
          get: async (options) => ({
            data: {
              id: options?.path?.id ?? 'ses-fail-1',
              title: '列表失败会话',
              directory: '/tmp/fail-1',
              projectID: 'proj-fail',
              workspaceID: 'ws-fail',
            },
          }),
        },
        _client: {
          get: async (options) => {
            if (options?.url === '/session') {
              throw new Error('raw list sessions failure');
            }
            return { data: [] };
          },
        },
      }),
    });
    const sent = [];

    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-fail-1',
      action: 'chat',
      payload: { toolSessionId: 'tool-fail-1', text: '/sessions' },
    });

    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(sent[0], {
      type: 'tool_error',
      toolSessionId: 'tool-fail-1',
      error: '查询会话列表失败, 当前宿主不可用',
    });
  });

  test('slash model sets override for current session and later chat carries model until session switch', async () => {
    const prompts = [];
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        session: {
          create: async () => ({
            data: {
              id: 'ses-model-1',
              title: '模型会话一',
              directory: '/tmp/proj-1',
              projectID: 'proj-1',
              workspaceID: 'ws-1',
            },
          }),
          get: async (options) => {
            if (options?.path?.id === 'ses-model-2') {
              return {
                data: {
                  id: 'ses-model-2',
                  title: '模型会话二',
                  directory: '/tmp/proj-1',
                  projectID: 'proj-1',
                  workspaceID: 'ws-1',
                },
              };
            }
            return {
              data: {
                id: options?.path?.id ?? 'ses-model-1',
                title: '模型会话一',
                directory: '/tmp/proj-1',
                projectID: 'proj-1',
                workspaceID: 'ws-1',
              },
            };
          },
          prompt: async (options) => {
            prompts.push(options);
            return { data: { ok: true } };
          },
        },
        _client: {
          get: async (options) => {
            if (options?.url === '/config/providers') {
              return {
                data: {
                  providers: [
                    {
                      id: 'openai',
                      models: {
                        'gpt-5.4': { id: 'gpt-5.4' },
                      },
                    },
                  ],
                },
              };
            }
            if (options?.url === '/session') {
              return {
                data: [
                  { id: 'ses-model-1', title: '模型会话一', directory: '/tmp/proj-1', projectID: 'proj-1', workspaceID: 'ws-1' },
                  { id: 'ses-model-2', title: '模型会话二', directory: '/tmp/proj-1', projectID: 'proj-1', workspaceID: 'ws-1' },
                ],
              };
            }
            return { data: [] };
          },
        },
      }),
    });
    const sent = [];

    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-model-1',
      action: 'chat',
      payload: { toolSessionId: 'tool-model-1', text: '/model openai/gpt-5.4' },
    });
    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-model-2',
      action: 'chat',
      payload: { toolSessionId: 'tool-model-1', text: 'hello model 1' },
    });
    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-model-3',
      action: 'chat',
      payload: { toolSessionId: 'tool-model-1', text: '/session ses-model-2' },
    });
    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-model-4',
      action: 'chat',
      payload: { toolSessionId: 'tool-model-1', text: 'hello model 2' },
    });

    assertSyntheticAssistantReply(sent, 0, 'tool-model-1', '后续请求将使用该模型 openai/gpt-5.4');
    assertSyntheticAssistantReply(sent, 6, 'tool-model-1', '已切换会话 `ses-model-2` 模型会话二');
    assert.deepStrictEqual(prompts, [
      {
        path: { id: 'ses-model-1' },
        query: { directory: '/tmp/proj-1' },
        body: {
          model: { providerID: 'openai', modelID: 'gpt-5.4' },
          parts: [{ type: 'text', text: 'hello model 1' }],
        },
      },
      {
        path: { id: 'ses-model-2' },
        query: { directory: '/tmp/proj-1' },
        body: {
          parts: [{ type: 'text', text: 'hello model 2' }],
        },
      },
    ]);
  });

  test('question_reply keeps targeting the original host session after slash creates a new active session', async () => {
    const questionListCalls = [];
    const questionReplyCalls = [];
    let createdCount = 0;
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        session: {
          create: async () => {
            createdCount += 1;
            if (createdCount === 1) {
              return {
                data: {
                  id: 'ses-question-1',
                  title: '问题会话一',
                  directory: '/tmp/question-1',
                },
              };
            }
            return {
              data: {
                id: 'ses-question-2',
                title: '问题会话二',
                directory: '/tmp/question-2',
              },
            };
          },
          get: async (options) => ({
            data: {
              id: options?.path?.id ?? 'unknown',
              directory: options?.path?.id === 'ses-question-2' ? '/tmp/question-2' : '/tmp/question-1',
            },
          }),
          prompt: async () => ({ data: { ok: true } }),
        },
        _client: {
          get: async (options) => {
            questionListCalls.push(options);
            return {
              data: [
                {
                  id: 'question-request-1',
                  sessionID: 'ses-question-1',
                  tool: { callID: 'call-question-1' },
                },
              ],
            };
          },
          post: async (options) => {
            questionReplyCalls.push(options);
            return { data: undefined };
          },
        },
      }),
    });

    runtime.gatewayConnection = { send: () => undefined };
    runtime.eventFilter = new EventFilter(['question.asked']);
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-question-bootstrap',
      action: 'chat',
      payload: { toolSessionId: 'tool-question-1', text: 'hello' },
    });
    await runtime.handleEvent({
      type: 'question.asked',
      properties: {
        id: 'question-asked-1',
        sessionID: 'ses-question-1',
        questions: [],
        tool: {
          messageID: 'msg-question-1',
          callID: 'call-question-1',
        },
      },
    });
    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-question-new',
      action: 'chat',
      payload: { toolSessionId: 'tool-question-1', text: '/new' },
    });
    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-question-reply',
      action: 'question_reply',
      payload: {
        questionId: 'question-request-1',
        answer: 'Vite',
      },
    });

    assert.deepStrictEqual(questionListCalls, []);
    assert.deepStrictEqual(questionReplyCalls, [
      {
        url: '/question/{requestID}/reply',
        path: { requestID: 'question-request-1' },
        body: { answers: [['Vite']] },
        headers: { 'Content-Type': 'application/json' },
      },
    ]);
  });

  test('session_not_found invalidates binding and next normal chat bootstraps a new host session', async () => {
    const prompts = [];
    let createCount = 0;
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        session: {
          create: async () => {
            createCount += 1;
            return {
              data: {
                id: createCount === 1 ? 'ses-invalid-1' : 'ses-invalid-2',
                title: createCount === 1 ? '失效前会话' : '重建后会话',
                directory: createCount === 1 ? '/tmp/invalid-1' : '/tmp/invalid-2',
              },
            };
          },
          get: async (options) => {
            if (options?.path?.id === 'ses-invalid-1') {
              const error = new Error('session missing');
              error.code = 'session_not_found';
              throw error;
            }
            return {
              data: {
                id: options?.path?.id ?? 'ses-invalid-2',
                directory: '/tmp/invalid-2',
              },
            };
          },
          prompt: async (options) => {
            prompts.push(options);
            return { data: { ok: true } };
          },
        },
      }),
    });
    const sent = [];

    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-invalid-1',
      action: 'chat',
      payload: { toolSessionId: 'tool-invalid', text: 'first prompt fails' },
    });

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].type, 'tool_error');
    assert.deepStrictEqual(runtime.bindingStore.get('tool-invalid'), {
      anchor: 'tool-invalid',
      activeOpencodeSessionId: 'ses-invalid-1',
      status: 'invalid',
    });
    assert.strictEqual(runtime.ownershipResolver.resolveAttachedAnchor('ses-invalid-1'), undefined);

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-invalid-2',
      action: 'chat',
      payload: { toolSessionId: 'tool-invalid', text: 'second prompt succeeds' },
    });

    assert.deepStrictEqual(runtime.bindingStore.get('tool-invalid'), {
      anchor: 'tool-invalid',
      activeOpencodeSessionId: 'ses-invalid-2',
      status: 'active',
    });
    assert.strictEqual(runtime.ownershipResolver.resolveAttachedAnchor('ses-invalid-2'), 'tool-invalid');
    assert.deepStrictEqual(prompts, [
      {
        path: { id: 'ses-invalid-2' },
        query: { directory: '/tmp/invalid-2' },
        body: {
          parts: [{ type: 'text', text: 'second prompt succeeds' }],
        },
      },
    ]);
    assert.deepStrictEqual(sent[1], {
      type: 'tool_done',
      toolSessionId: 'tool-invalid',
      welinkSessionId: 'wl-invalid-2',
    });
  });

  test('slash context failure uses unified template, invalidates binding, and does not emit duplicate tool_error', async () => {
    let createCount = 0;
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        session: {
          create: async () => {
            createCount += 1;
            return {
              data: {
                id: createCount === 1 ? 'ses-slash-invalid-1' : 'ses-slash-invalid-2',
                title: createCount === 1 ? 'slash 失效前会话' : 'slash 重建后会话',
                directory: createCount === 1 ? '/tmp/slash-invalid-1' : '/tmp/slash-invalid-2',
              },
            };
          },
          get: async (options) => {
            if (options?.path?.id === 'ses-slash-invalid-1') {
              const error = new Error('session missing');
              error.code = 'session_not_found';
              throw error;
            }
            return {
              data: {
                id: options?.path?.id ?? 'ses-slash-invalid-2',
                directory: '/tmp/slash-invalid-2',
              },
            };
          },
        },
      }),
    });
    const sent = [];

    runtime.gatewayConnection = { send: (msg) => sent.push(msg) };
    setRuntimeGatewayState(runtime, 'READY');
    runtime.bindingStore.bind('tool-slash-invalid', 'ses-slash-invalid-1');
    runtime.ownershipResolver.attach('ses-slash-invalid-1', 'tool-slash-invalid');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-slash-invalid-1',
      action: 'chat',
      payload: { toolSessionId: 'tool-slash-invalid', text: '/sessions' },
    });

    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(sent[0], {
      type: 'tool_error',
      toolSessionId: 'tool-slash-invalid',
      error: '查询会话列表失败, 当前没有可用会话',
    });
    assert.deepStrictEqual(runtime.bindingStore.get('tool-slash-invalid'), {
      anchor: 'tool-slash-invalid',
      activeOpencodeSessionId: 'ses-slash-invalid-1',
      status: 'invalid',
    });
    assert.strictEqual(runtime.ownershipResolver.resolveAttachedAnchor('ses-slash-invalid-1'), undefined);

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-slash-invalid-2',
      action: 'chat',
      payload: { toolSessionId: 'tool-slash-invalid', text: '/sessions' },
    });

    assert.strictEqual(sent.length, 6);
    assertSyntheticAssistantReply(sent, 1, 'tool-slash-invalid', '当前范围内没有可切换的会话');
    assert.deepStrictEqual(sent[5], { type: 'tool_done', toolSessionId: 'tool-slash-invalid' });
  });

  test('permission_reply keeps targeting the original host session after slash creates a new active session', async () => {
    const permissionCalls = [];
    let createdCount = 0;
    const runtime = new BridgeRuntime({
      client: createRuntimeClient({
        session: {
          create: async () => {
            createdCount += 1;
            if (createdCount === 1) {
              return {
                data: {
                  id: 'ses-permission-1',
                  title: '权限会话一',
                  directory: '/tmp/permission-1',
                },
              };
            }
            return {
              data: {
                id: 'ses-permission-2',
                title: '权限会话二',
                directory: '/tmp/permission-2',
              },
            };
          },
          get: async (options) => ({
            data: {
              id: options?.path?.id ?? 'unknown',
              directory: options?.path?.id === 'ses-permission-2' ? '/tmp/permission-2' : '/tmp/permission-1',
            },
          }),
          prompt: async () => ({ data: { ok: true } }),
        },
        _client: {
          get: async () => ({}),
          post: async (options) => {
            permissionCalls.push(options);
            return {};
          },
        },
      }),
    });

    runtime.gatewayConnection = { send: () => undefined };
    runtime.eventFilter = new EventFilter(['permission.asked']);
    setRuntimeGatewayState(runtime, 'READY');

    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-permission-bootstrap',
      action: 'chat',
      payload: { toolSessionId: 'tool-permission-1', text: 'hello' },
    });
    await runtime.handleEvent({
      type: 'permission.asked',
      properties: {
        sessionID: 'ses-permission-1',
        id: 'perm-1',
      },
    });
    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-permission-new',
      action: 'chat',
      payload: { toolSessionId: 'tool-permission-1', text: '/new' },
    });
    await runtime.handleDownstreamMessage({
      type: 'invoke',
      welinkSessionId: 'wl-permission-reply',
      action: 'permission_reply',
      payload: {
        permissionId: 'perm-1',
        response: 'once',
      },
    });

    assert.deepStrictEqual(permissionCalls, [
      {
        url: '/session/{id}/permissions/{permissionID}',
        path: { id: '__bridge_permission_compat__', permissionID: 'perm-1' },
        body: { response: 'once' },
        headers: { 'Content-Type': 'application/json' },
      },
    ]);
  });
});
