import type { HostClientLike, OpencodeClient, OpencodeHealthResult } from '../types/index.js';

export const REQUIRED_SDK_CAPABILITIES = [
  'session.create',
  'session.prompt',
  'session.abort',
  'session.delete',
  'postSessionIdPermissionsPermissionId',
  '_client.get',
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
  permission?: Record<string, unknown>;
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

function buildLegacyPermissionReplyOptions(parameters: {
  sessionID: string;
  permissionID: string;
  directory?: string;
  response: 'once' | 'always' | 'reject';
}): Record<string, unknown> {
  return {
    path: {
      id: parameters.sessionID,
      permissionID: parameters.permissionID,
    },
    body: {
      response: parameters.response,
    },
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
  const rawClient = isRecord(root?._client) ? root._client : undefined;

  return REQUIRED_SDK_CAPABILITIES.filter((capability) => {
    switch (capability) {
      case 'session.create':
        return typeof session?.create !== 'function';
      case 'session.prompt':
        return typeof session?.prompt !== 'function';
      case 'session.abort':
        return typeof session?.abort !== 'function';
      case 'session.delete':
        return typeof session?.delete !== 'function';
      case 'postSessionIdPermissionsPermissionId':
        return typeof root?.postSessionIdPermissionsPermissionId !== 'function';
      case '_client.get':
        return typeof rawClient?.get !== 'function';
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

export function createSdkAdapter(client: unknown): OpencodeClient | null {
  if (getMissingSdkCapabilities(client).length > 0) {
    return null;
  }

  const root = client as {
    session: {
      create: (options?: Record<string, unknown>) => Promise<unknown>;
      get?: (options: Record<string, unknown>) => Promise<unknown>;
      prompt: (options: Record<string, unknown>) => Promise<unknown>;
      abort: (options: Record<string, unknown>) => Promise<unknown>;
      delete: (options: Record<string, unknown>) => Promise<unknown>;
    };
    postSessionIdPermissionsPermissionId: (options: Record<string, unknown>) => Promise<unknown>;
    _client: {
      get: OpencodeClient['_client']['get'];
      post: OpencodeClient['_client']['post'];
    };
  };

  const getSession = typeof root.session.get === 'function'
    ? (parameters: { sessionID: string; directory?: string }) => root.session.get!(buildLegacySessionTarget(parameters))
    : undefined;

  return {
    session: {
      create: (parameters) => root.session.create(buildLegacyCreateOptions(parameters)),
      ...(getSession ? { get: getSession } : {}),
      prompt: (parameters) => root.session.prompt(buildLegacyPromptOptions(parameters)),
      abort: (parameters) => root.session.abort(buildLegacySessionTarget(parameters)),
      delete: (parameters) => root.session.delete(buildLegacySessionTarget(parameters)),
    },
    postSessionIdPermissionsPermissionId: (parameters) =>
      root.postSessionIdPermissionsPermissionId(buildLegacyPermissionReplyOptions(parameters)),
    _client: {
      get: (options) => root._client.get(options),
      post: (options) => root._client.post(options),
    },
  };
}
