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

/**
 * 解析业务入口策略。
 * @remarks 策略只由 entryKey 模板决定；服务端下发的 allowedSlashCommands 不参与本地控制命令过滤。
 */
export class DefaultBusinessEntryPolicyResolver {
  private readonly entryKeyCodec = new DefaultEntryKeyCodec();

  resolve(input: { entryKey: BusinessEntryKey; extParameters?: unknown }): BusinessEntryPolicy {
    void input.extParameters;
    const template = this.resolveTemplate(input.entryKey);
    return {
      entryKey: this.entryKeyCodec.stringify(input.entryKey),
      controlled: template.controlled,
      allowOpencodeNativeSessions: template.allowOpencodeNativeSessions,
      allowedSlashCommands: template.allowedSlashCommands,
      slashPolicySource: 'entry_template',
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
