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
type LegacySdkMethod = (options?: Record<string, unknown>) => Promise<unknown>;
type LegacyRequiredSdkMethod = (options: Record<string, unknown>) => Promise<unknown>;
type LegacyRawClient = {
  get: LegacyRequiredSdkMethod;
  post: LegacyRequiredSdkMethod;
};

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

function buildLegacyCommandOptions(parameters: {
  sessionID: string;
  directory?: string;
  messageID?: string;
  agent?: string;
  model?: string;
  command: string;
  arguments?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    command: parameters.command,
  };
  if (parameters.messageID !== undefined) body.messageID = parameters.messageID;
  if (parameters.arguments !== undefined) body.arguments = parameters.arguments;
  if (parameters.agent !== undefined) body.agent = parameters.agent;
  if (parameters.model !== undefined) body.model = parameters.model;

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
  const sessionCreate = asFunction<LegacySdkMethod>(root.session.create, root.session);
  const sessionGet = asFunction<LegacyRequiredSdkMethod>(root.session.get, root.session);
  const sessionList = asFunction<LegacySdkMethod>(root.session.list, root.session);
  const sessionPrompt = asFunction<LegacyRequiredSdkMethod>(root.session.prompt, root.session);
  const sessionCommand = asFunction<LegacyRequiredSdkMethod>(root.session.command, root.session);
  const sessionAbort = asFunction<LegacyRequiredSdkMethod>(root.session.abort, root.session);
  const sessionDelete = asFunction<LegacyRequiredSdkMethod>(root.session.delete, root.session);
  const commandList = asFunction<LegacySdkMethod>(root.command?.list, root.command);
  const configProviders = asFunction<LegacySdkMethod>(root.config.providers, root.config);
  const rawClient = (root as unknown as { _client: LegacyRawClient })._client;

  return {
    session: {
      create: (parameters) => sessionCreate?.(buildLegacyCreateOptions(parameters)) ?? Promise.reject(new Error('OpenCode session.create is unavailable')),
      get: (parameters) => sessionGet?.(buildLegacySessionTarget(parameters)) ?? Promise.reject(new Error('OpenCode session.get is unavailable')),
      list: (parameters) => sessionList?.(buildLegacyScopedQuery(parameters)) ?? Promise.reject(new Error('OpenCode session.list is unavailable')),
      prompt: (parameters) => sessionPrompt?.(buildLegacyPromptOptions(parameters)) ?? Promise.reject(new Error('OpenCode session.prompt is unavailable')),
      ...(sessionCommand
        ? { command: (parameters) => sessionCommand(buildLegacyCommandOptions(parameters)) }
        : {}),
      abort: (parameters) => sessionAbort?.(buildLegacySessionTarget(parameters)) ?? Promise.reject(new Error('OpenCode session.abort is unavailable')),
      delete: (parameters) => sessionDelete?.(buildLegacySessionTarget(parameters)) ?? Promise.reject(new Error('OpenCode session.delete is unavailable')),
    },
    ...(commandList
      ? {
          command: {
            list: (parameters) => commandList(buildLegacyScopedQuery(parameters)),
          },
        }
      : {}),
    config: {
      providers: (parameters) => configProviders?.(buildLegacyScopedQuery(parameters)) ?? Promise.reject(new Error('OpenCode config.providers is unavailable')),
    },
    permission: {
      // OpenCode server plugin 注入的 v1 client 没有高层 permission reply；这里直接走 requestID raw endpoint。
      reply: (parameters) => rawClient.post({
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
      reply: (parameters) => rawClient.post({
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
