import { asRecord } from '../utils/type-guards.js';

function listKeys(value: unknown): string[] {
  const record = asRecord(value);
  return record ? Object.keys(record).sort() : [];
}

function hasFunction(record: Record<string, unknown> | undefined, key: string): boolean {
  return typeof record?.[key] === 'function';
}

export function buildClientShapeSummary(client: unknown): Record<string, unknown> {
  const root = asRecord(client) ?? undefined;
  const global = asRecord(root?.global) ?? undefined;
  const app = asRecord(root?.app) ?? undefined;
  const session = asRecord(root?.session) ?? undefined;
  const rawClient = asRecord(root?._client) ?? undefined;

  return {
    clientTopLevelKeys: listKeys(root),
    globalKeys: listKeys(global),
    appKeys: listKeys(app),
    sessionKeys: listKeys(session),
    rawClientKeys: listKeys(rawClient),
    hasGlobalHealth: hasFunction(global, 'health'),
    hasAppHealth: hasFunction(app, 'health'),
    hasAppLog: hasFunction(app, 'log'),
    hasSessionCreate: hasFunction(session, 'create'),
    hasSessionGet: hasFunction(session, 'get'),
    hasSessionPrompt: hasFunction(session, 'prompt'),
    hasSessionAbort: hasFunction(session, 'abort'),
    hasSessionDelete: hasFunction(session, 'delete'),
    hasPermissionReply: hasFunction(rawClient, 'post'),
    hasLegacyPermissionRespond: hasFunction(root, 'postSessionIdPermissionsPermissionId'),
    hasRawClientGet: hasFunction(rawClient, 'get'),
    hasRawClientPost: hasFunction(rawClient, 'post'),
  };
}
