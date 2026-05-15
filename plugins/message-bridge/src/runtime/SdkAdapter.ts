import type { BridgeSdkClient, HostClientLike, HostSdkClient, OpencodeHealthResult } from '../types/index.js';

export const REQUIRED_SDK_CAPABILITIES = [
  'session.create',
  'session.get',
  'session.list',
  'session.prompt',
  'session.abort',
  'session.delete',
  'config.providers',
  'postSessionIdPermissionsPermissionId',
  '_client.post',
] as const;

export type SdkClientCapability = typeof REQUIRED_SDK_CAPABILITIES[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function asFunction<T extends (...args: never[]) => unknown>(value: unknown, bindTarget?: unknown): T | undefined {
  if (typeof value !== 'function') {
    return undefined;
  }

  return (bindTarget ? value.bind(bindTarget) : value) as T;
}

function normalizeHealthResponse(response: unknown): OpencodeHealthResult {
  if (isRecord(response) && 'error' in response && response.error !== undefined) {
    const error = response.error;
    const message =
      isRecord(error) && typeof error.message === 'string'
        ? error.message
        : typeof error === 'string'
          ? error
          : 'OpenCode health request failed';
    throw new Error(message);
  }

  const payload =
    isRecord(response) && 'data' in response
      ? response.data
      : response;

  if (!isRecord(payload) || typeof payload.healthy !== 'boolean') {
    throw new Error('Invalid global health response');
  }

  return payload as unknown as OpencodeHealthResult;
}

type AdaptedGlobalHealth = NonNullable<HostClientLike['global']>['health'];

function buildLegacyCreateOptions(parameters?: {
  directory?: string;
  parentID?: string;
  title?: string;
  permission?: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  if (!parameters) {
    return {};
  }

  const body: Record<string, unknown> = {};
  if (parameters.parentID !== undefined) body.parentID = parameters.parentID;
  if (parameters.title !== undefined) body.title = parameters.title;
  if (parameters.permission !== undefined) body.permission = parameters.permission;

  return {
    ...(Object.keys(body).length > 0 ? { body } : {}),
    ...(parameters.directory ? { query: { directory: parameters.directory } } : {}),
  };
}

function buildLegacySessionTarget(parameters: { sessionID: string; directory?: string }): Record<string, unknown> {
  return {
    path: { id: parameters.sessionID },
    ...(parameters.directory ? { query: { directory: parameters.directory } } : {}),
  };
}

function buildLegacyScopedQuery(parameters?: { directory?: string }): Record<string, unknown> {
  return {
    ...(parameters?.directory ? { query: { directory: parameters.directory } } : {}),
  };
}

function buildLegacyPromptOptions(parameters: {
  sessionID: string;
  directory?: string;
  messageID?: string;
  model?: {
    providerID: string;
    modelID: string;
  };
  agent?: string;
  noReply?: boolean;
  tools?: {
    [key: string]: boolean;
  };
  format?: unknown;
  system?: string;
  variant?: string;
  parts?: Array<{ type: 'text'; text: string }>;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (parameters.messageID !== undefined) body.messageID = parameters.messageID;
  if (parameters.model !== undefined) body.model = parameters.model;
  if (parameters.agent !== undefined) body.agent = parameters.agent;
  if (parameters.noReply !== undefined) body.noReply = parameters.noReply;
  if (parameters.tools !== undefined) body.tools = parameters.tools;
  if (parameters.format !== undefined) body.format = parameters.format;
  if (parameters.system !== undefined) body.system = parameters.system;
  if (parameters.variant !== undefined) body.variant = parameters.variant;
  if (parameters.parts !== undefined) body.parts = parameters.parts;

  return {
    path: { id: parameters.sessionID },
    body,
    ...(parameters.directory ? { query: { directory: parameters.directory } } : {}),
  };
}

function adaptGlobalHealth(root: Record<string, unknown> | undefined): AdaptedGlobalHealth {
  const global = isRecord(root?.global) ? root.global : undefined;
  const rawClient = isRecord(root?._client) ? root._client : undefined;
  const globalHealth = asFunction<(options?: Record<string, unknown>) => Promise<OpencodeHealthResult> | OpencodeHealthResult>(
    global?.health,
    global,
  );

  if (globalHealth) {
    return globalHealth;
  }

  const rawGet = asFunction<(options: Record<string, unknown>) => Promise<unknown>>(rawClient?.get, rawClient);
  if (!rawGet) {
    return undefined;
  }

  return async () => normalizeHealthResponse(await rawGet({ url: '/global/health' }));
}

export function getMissingSdkCapabilities(client: unknown): SdkClientCapability[] {
  const root = isRecord(client) ? client : undefined;
  const session = isRecord(root?.session) ? root.session : undefined;
  const config = isRecord(root?.config) ? root.config : undefined;
  const rawClient = isRecord(root?._client) ? root._client : undefined;

  return REQUIRED_SDK_CAPABILITIES.filter((capability) => {
    switch (capability) {
      case 'session.create':
        return typeof session?.create !== 'function';
      case 'session.get':
        return typeof session?.get !== 'function';
      case 'session.list':
        return typeof session?.list !== 'function';
      case 'session.prompt':
        return typeof session?.prompt !== 'function';
      case 'session.abort':
        return typeof session?.abort !== 'function';
      case 'session.delete':
        return typeof session?.delete !== 'function';
      case 'config.providers':
        return typeof config?.providers !== 'function';
      case 'postSessionIdPermissionsPermissionId':
        return typeof root?.postSessionIdPermissionsPermissionId !== 'function';
      case '_client.post':
        return typeof rawClient?.post !== 'function';
      default:
        return true;
    }
  });
}

export function toHostClientLike(client: unknown): HostClientLike {
  const root = isRecord(client) ? client : undefined;
  const app = isRecord(root?.app) ? root.app : undefined;

  return {
    global: {
      health: adaptGlobalHealth(root),
    },
    app: {
      log: asFunction(app?.log, app),
    },
  };
}

/**
 * 当前 OpenCode deprecated permission route 在服务端仅消费 permissionID/requestID。
 * adapter 在内部补一个稳定占位 sessionID，避免把兼容细节暴露给业务层。
 *
 * @remarks
 * 这里依赖的是当前 OpenCode 服务端的兼容行为，而不是桥接层对外契约：
 * 业务代码只需要提供 permissionId/response，不应感知 sessionID 占位值。
 * 等官方稳定的 requestID 级 permission reply façade 可用后，应优先删除这条兼容路径。
 */
const LEGACY_PERMISSION_REPLY_SESSION_ID = 'ses_bridge_permission_compat';

export function createSdkAdapter(client: unknown): BridgeSdkClient | null {
  if (getMissingSdkCapabilities(client).length > 0) {
    return null;
  }

  const root = client as HostSdkClient;

  return {
    session: {
      create: (parameters) => root.session.create(buildLegacyCreateOptions(parameters)),
      get: (parameters) => root.session.get(buildLegacySessionTarget(parameters)),
      list: (parameters) => root.session.list(buildLegacyScopedQuery(parameters)),
      prompt: (parameters) => root.session.prompt(buildLegacyPromptOptions(parameters)),
      abort: (parameters) => root.session.abort(buildLegacySessionTarget(parameters)),
      delete: (parameters) => root.session.delete(buildLegacySessionTarget(parameters)),
    },
    config: {
      providers: (parameters) => root.config.providers(buildLegacyScopedQuery(parameters)),
    },
    permission: {
      // 兼容 deprecated route 的细节只允许停留在 adapter 内部，业务层不暴露 sessionID。
      reply: (parameters) => root.postSessionIdPermissionsPermissionId({
        url: '/session/{id}/permissions/{permissionID}',
        path: {
          id: LEGACY_PERMISSION_REPLY_SESSION_ID,
          permissionID: parameters.permissionId,
        },
        ...(parameters.directory ? { query: { directory: parameters.directory } } : {}),
        body: {
          response: parameters.response,
        },
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    },
    question: {
      // 当前正式 SDK 仍缺少 question reply 高层方法，暂时仅在 adapter 内部保留 raw fallback。
      reply: (parameters) => root._client.post({
        url: '/question/{requestID}/reply',
        path: { requestID: parameters.questionId },
        body: { answers: [[parameters.answer]] },
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    },
  };
}
