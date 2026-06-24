import type { BridgeSdkClient, HostClientLike, HostSdkClient, OpencodeHealthResult } from '../types/index.js';

export const REQUIRED_SDK_CAPABILITIES = [
  'session.create',
  'session.get',
  'session.list',
  'session.prompt',
  'session.abort',
  'session.delete',
  'config.providers',
  '_client.post',
] as const;

export type SdkClientCapability = typeof REQUIRED_SDK_CAPABILITIES[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function asRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
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
    let message = 'OpenCode health request failed';
    if (isRecord(error) && typeof error.message === 'string') {
      message = error.message;
    } else if (typeof error === 'string') {
      message = error;
    }
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
  if (parameters.parentID !== undefined) {body.parentID = parameters.parentID;}
  if (parameters.title !== undefined) {body.title = parameters.title;}
  if (parameters.permission !== undefined) {body.permission = parameters.permission;}

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

function buildLegacyScopedQuery(parameters?: { directory?: string; roots?: boolean; start?: number }): Record<string, unknown> {
  const query = {
    ...(parameters?.directory ? { directory: parameters.directory } : {}),
    ...(parameters?.roots !== undefined ? { roots: parameters.roots } : {}),
    ...(parameters?.start !== undefined ? { start: parameters.start } : {}),
  };
  return {
    ...(Object.keys(query).length > 0 ? { query } : {}),
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
  if (parameters.messageID !== undefined) {body.messageID = parameters.messageID;}
  if (parameters.model !== undefined) {body.model = parameters.model;}
  if (parameters.agent !== undefined) {body.agent = parameters.agent;}
  if (parameters.noReply !== undefined) {body.noReply = parameters.noReply;}
  if (parameters.tools !== undefined) {body.tools = parameters.tools;}
  if (parameters.format !== undefined) {body.format = parameters.format;}
  if (parameters.system !== undefined) {body.system = parameters.system;}
  if (parameters.variant !== undefined) {body.variant = parameters.variant;}
  if (parameters.parts !== undefined) {body.parts = parameters.parts;}

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
  const root = asRecordOrUndefined(client);
  const session = asRecordOrUndefined(root?.session);
  const config = asRecordOrUndefined(root?.config);
  const rawClient = asRecordOrUndefined(root?._client);
  const available: Record<SdkClientCapability, boolean> = {
    'session.create': asFunction(session?.create) !== undefined,
    'session.get': asFunction(session?.get) !== undefined,
    'session.list': asFunction(session?.list) !== undefined,
    'session.prompt': asFunction(session?.prompt) !== undefined,
    'session.abort': asFunction(session?.abort) !== undefined,
    'session.delete': asFunction(session?.delete) !== undefined,
    'config.providers': asFunction(config?.providers) !== undefined,
    '_client.post': asFunction(rawClient?.post) !== undefined,
  };

  return REQUIRED_SDK_CAPABILITIES.filter((capability) => !available[capability]);
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
      // OpenCode server plugin 注入的 v1 client 没有高层 permission reply；这里直接走 requestID raw endpoint。
      reply: (parameters) => root._client.post({
        url: '/permission/{requestID}/reply',
        path: { requestID: parameters.permissionId },
        ...(parameters.directory ? { query: { directory: parameters.directory } } : {}),
        body: {
          reply: parameters.response,
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
        body: { answers: parameters.answers },
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    },
  };
}
