import type {
  ProviderError,
  ProviderFact,
  ProviderRun,
  ProviderTerminalResult,
} from '@wecode/bridge-runtime-sdk';
import type { PromptSessionTerminal } from '../../port/SessionScopedActionGatewayPort.js';
import { getToolErrorEvidence } from '../../utils/error.js';
import { asRecord, asTrimmedString } from '../../utils/type-guards.js';

export function fromFacts<T extends ProviderFact>(facts: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const fact of facts) {
        yield fact;
      }
    },
  };
}

function resolvePermissionPattern(properties: Record<string, unknown> | undefined): string | undefined {
  const patterns = properties?.patterns;
  if (Array.isArray(patterns)) {
    for (const pattern of patterns) {
      const value = asTrimmedString(pattern);
      if (value) {
        return value;
      }
    }
  }

  const legacyPattern = properties?.pattern;
  if (Array.isArray(legacyPattern)) {
    for (const pattern of legacyPattern) {
      const value = asTrimmedString(pattern);
      if (value) {
        return value;
      }
    }
    return undefined;
  }

  return asTrimmedString(legacyPattern);
}

function unsafePermissionMetadata(properties: Record<string, unknown> | undefined): Record<string, unknown> {
  return asRecord(properties?.metadata) ?? {};
}

/**
 * 安全读取 permission metadata。
 * @remarks
 * 上游 metadata 可能来自代理对象或异常 getter；读取失败时不阻断 permission.ask 输出。
 */
export function safePermissionMetadata(
  properties: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  try {
    return unsafePermissionMetadata(properties);
  } catch {
    return undefined;
  }
}

function metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  return asTrimmedString(metadata[key]);
}

function resolvePermissionPathTitle(
  prefix: string,
  metadata: Record<string, unknown>,
  pattern: string | undefined,
  ...metadataKeys: string[]
): string | undefined {
  for (const key of metadataKeys) {
    const value = metadataString(metadata, key);
    if (value) {
      return `${prefix} ${value}`;
    }
  }
  return pattern ? `${prefix} ${pattern}` : undefined;
}

const KNOWN_PERM_TYPES = new Set([
  'bash', 'edit', 'read', 'glob', 'grep', 'list', 'task', 'webfetch', 'websearch', 'external_directory',
]);

export function isKnownPermType(permType: string): boolean {
  return KNOWN_PERM_TYPES.has(permType);
}

function resolvePermissionAskTitleUnsafe(properties: Record<string, unknown> | undefined, permType: string): string {
  const metadata = unsafePermissionMetadata(properties);
  const pattern = resolvePermissionPattern(properties);

  switch (permType) {
    case 'bash':
      return metadataString(metadata, 'description') ?? '';
    case 'edit':
      return resolvePermissionPathTitle('Edit', metadata, pattern, 'filepath') ?? '';
    case 'read':
      return resolvePermissionPathTitle('Read', metadata, pattern, 'filePath', 'filepath') ?? '';
    case 'glob':
      return resolvePermissionPathTitle('Glob', metadata, pattern, 'pattern') ?? '';
    case 'grep':
      return resolvePermissionPathTitle('Grep', metadata, pattern, 'pattern') ?? '';
    case 'list':
      return resolvePermissionPathTitle('List', metadata, pattern, 'path') ?? '';
    case 'task': {
      const subagentType = metadataString(metadata, 'subagent_type') ?? pattern;
      return subagentType ? `${subagentType} Task` : '';
    }
    case 'webfetch':
      return resolvePermissionPathTitle('WebFetch', metadata, pattern, 'url') ?? '';
    case 'websearch': {
      const query = metadataString(metadata, 'query') ?? pattern;
      return query ? `WebSearch "${query}"` : '';
    }
    case 'external_directory':
      return resolvePermissionPathTitle(
        'Access external directory',
        metadata,
        pattern,
        'parentDir',
        'filepath',
      ) ?? '';
    default:
      return pattern ?? '';
  }
}

/**
 * 从 OpenCode permission.asked 原始属性中推导展示 title。
 * @remarks
 * 没有可展示字段或提取异常时返回空字符串，调用方应继续发送 permission.ask。
 */
export function resolvePermissionAskTitle(
  properties: Record<string, unknown> | undefined,
  permType: string,
): string {
  try {
    return resolvePermissionAskTitleUnsafe(properties, permType);
  } catch {
    return '';
  }
}

export function toProviderTerminalResult(terminal: PromptSessionTerminal): ProviderTerminalResult {
  switch (terminal.kind) {
    case 'completed':
      return { outcome: 'completed' };
    case 'aborted':
      return { outcome: 'aborted' };
    case 'failed':
      return {
        outcome: 'failed',
        error: {
          code: terminal.errorCode,
          message: terminal.errorMessage,
          ...(terminal.errorDetails ? { details: terminal.errorDetails } : {}),
        },
      };
    default:
      throw new Error(`Unsupported prompt terminal: ${JSON.stringify(terminal)}`);
  }
}

export function buildImmediateFailedRun(toolSessionId: string, error: ProviderError): ProviderRun {
  return {
    runId: `immediate-${toolSessionId}`,
    facts: fromFacts([]),
    async result() {
      return {
        outcome: 'failed',
        error,
      };
    },
  };
}

export function appendTerminalSourceEvidence(
  extra: Record<string, unknown>,
  errorDetails: unknown,
): Record<string, unknown> {
  const evidence = getToolErrorEvidence(errorDetails);
  return {
    ...extra,
    ...(evidence?.sourceOperation ? { sourceOperation: evidence.sourceOperation } : {}),
    ...(evidence?.sourceErrorCode ? { sourceErrorCode: evidence.sourceErrorCode } : {}),
    ...(evidence?.httpStatus !== undefined ? { httpStatus: evidence.httpStatus } : {}),
  };
}

export function hasPlatformBusinessSessionId(extParameters: unknown): boolean {
  if (typeof extParameters !== 'object' || extParameters === null || Array.isArray(extParameters)) {
    return false;
  }
  const platformExtParam = (extParameters as Record<string, unknown>).platformExtParam;
  if (typeof platformExtParam !== 'object' || platformExtParam === null || Array.isArray(platformExtParam)) {
    return false;
  }
  const businessSessionId = (platformExtParam as Record<string, unknown>).businessSessionId;
  return typeof businessSessionId === 'string' && businessSessionId.trim().length > 0;
}
