import { asRecord } from '../utils/type-guards.js';

function listKeys(value: unknown): string[] {
  const record = asRecord(value);
  return record ? Object.keys(record).sort() : [];
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
    hasGlobalHealth: typeof global?.health === 'function',
    hasAppHealth: typeof app?.health === 'function',
    hasAppLog: typeof app?.log === 'function',
    hasSessionCreate: typeof session?.create === 'function',
    hasSessionGet: typeof session?.get === 'function',
    hasSessionPrompt: typeof session?.prompt === 'function',
    hasSessionAbort: typeof session?.abort === 'function',
    hasSessionDelete: typeof session?.delete === 'function',
    hasPermissionReply: typeof root?.postSessionIdPermissionsPermissionId === 'function',
    hasRawClientGet: typeof rawClient?.get === 'function',
    hasRawClientPost: typeof rawClient?.post === 'function',
  };
}
