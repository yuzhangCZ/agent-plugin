import type { BridgeEvent } from '../../../runtime/types.js';
import type { SessionDeletedEventInput } from '../../../port/session-isolation/dto/commands/index.js';
import { asRecord, asTrimmedString } from '../../../utils/type-guards.js';

export interface SessionDeletedEventHandler {
  toInput(event: BridgeEvent): SessionDeletedEventInput | undefined;
}

/**
 * 将 `session.deleted` 控制事件转换为删除补偿 use case 输入。
 */
export class DefaultSessionDeletedEventHandler implements SessionDeletedEventHandler {
  toInput(event: BridgeEvent): SessionDeletedEventInput | undefined {
    if (event.type !== 'session.deleted') {
      return undefined;
    }

    const properties = asRecord(event.properties);
    const sessionId = asTrimmedString(asRecord(properties?.info)?.id)
      ?? asTrimmedString(properties?.sessionID);
    return sessionId ? { sessionId } : undefined;
  }
}
