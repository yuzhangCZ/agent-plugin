import type { BusinessEntryKey } from '../../../domain/session-isolation/index.js';
import { DefaultEntryKeyCodec } from '../../../domain/session-isolation/index.js';
import type { BusinessEntryPolicy } from '../../../port/session-isolation/dto/commands/index.js';

type AllowedSlashCommandKind = BusinessEntryPolicy['allowedSlashCommands'][number];

const ALL_SLASH_COMMAND_KINDS: AllowedSlashCommandKind[] = [
  'new',
  'sessions',
  'session',
  'models',
  'model',
];

const LIMITED_SLASH_COMMAND_KINDS: AllowedSlashCommandKind[] = ['new', 'models', 'model'];

const KNOWN_SLASH_COMMAND_KINDS = new Set<AllowedSlashCommandKind>(ALL_SLASH_COMMAND_KINDS);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readAllowedSlashCommands(value: unknown): AllowedSlashCommandKind[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is AllowedSlashCommandKind => (
    typeof item === 'string'
    && KNOWN_SLASH_COMMAND_KINDS.has(item as AllowedSlashCommandKind)
  ));
}

/**
 * 解析业务入口策略。
 * @remarks 策略由 entryKey 模板决定，请求级 slash 白名单只对当前请求做交集覆盖。
 */
export class DefaultBusinessEntryPolicyResolver {
  private readonly entryKeyCodec = new DefaultEntryKeyCodec();

  resolve(input: { entryKey: BusinessEntryKey; extParameters?: unknown }): BusinessEntryPolicy {
    const extParameters = asRecord(input.extParameters);
    const platformExtParam = asRecord(extParameters?.platformExtParam);
    const template = this.resolveTemplate(input.entryKey);
    const requestAllowedSlashCommands = readAllowedSlashCommands(platformExtParam?.allowedSlashCommands);
    return {
      entryKey: this.entryKeyCodec.stringify(input.entryKey),
      controlled: template.controlled,
      allowOpencodeNativeSessions: template.allowOpencodeNativeSessions,
      allowedSlashCommands: requestAllowedSlashCommands
        ? requestAllowedSlashCommands.filter((command) => template.allowedSlashCommands.includes(command))
        : template.allowedSlashCommands,
      slashPolicySource: requestAllowedSlashCommands ? 'request_payload' : 'entry_template',
    };
  }

  private resolveTemplate(entryKey: BusinessEntryKey): Omit<BusinessEntryPolicy, 'entryKey'> {
    const domain = entryKey.businessSessionDomain.toLowerCase();
    const type = entryKey.businessSessionType.toLowerCase();
    if ((domain === 'im' || domain === 'miniapp') && type === 'direct') {
      return {
        controlled: false,
        allowOpencodeNativeSessions: true,
        allowedSlashCommands: ALL_SLASH_COMMAND_KINDS,
      };
    }
    return {
      controlled: true,
      allowOpencodeNativeSessions: false,
      allowedSlashCommands: LIMITED_SLASH_COMMAND_KINDS,
    };
  }
}
