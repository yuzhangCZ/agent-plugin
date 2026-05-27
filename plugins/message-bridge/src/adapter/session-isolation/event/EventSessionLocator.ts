import type { BridgeEvent } from '../../../runtime/types.js';
import { asRecord, asTrimmedString } from '../../../utils/type-guards.js';

export interface EventSessionLocator {
  locate(event: BridgeEvent): string | undefined;
}

/**
 * 从 OpenCode raw event 中抽取宿主 session id。
 * @remarks 这里只做字段定位，不判断 ownership，也不执行转发。
 */
export class DefaultEventSessionLocator implements EventSessionLocator {
  locate(event: BridgeEvent): string | undefined {
    const properties = asRecord(event.properties);
    switch (event.type) {
      case 'message.updated':
        return asTrimmedString(asRecord(properties?.info)?.sessionID);
      case 'message.part.delta':
      case 'question.asked':
      case 'permission.asked':
      case 'permission.replied':
      case 'session.error':
      case 'session.idle':
        return asTrimmedString(properties?.sessionID);
      case 'message.part.updated':
        return asTrimmedString(asRecord(properties?.part)?.sessionID);
      case 'session.updated':
        return asTrimmedString(asRecord(properties?.info)?.id);
      default:
        return undefined;
    }
  }
}
