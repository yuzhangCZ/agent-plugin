import type { CreateSessionPayload } from '../contracts/downstream-messages.js';

/**
 * 统一建会话请求。
 * @remarks
 * 这是 create use case 唯一可见的入口语义，禁止泄露 chat/create_session 私有判定细节。
 */
export interface CreateSessionRequest {
  title?: string;
  assistantId?: string;
  isGroupChat: boolean;
}

/** chat 触发路径创建会话时允许传入的原始上下文。 */
export interface ChatCreateSessionContext {
  assistantId?: string;
  imGroupId?: string;
}

/** 负责把不同入口归一化成统一建会话语义。 */
export class CreateSessionRequestNormalizer {
  fromCreateSessionPayload(payload: CreateSessionPayload): CreateSessionRequest {
    return {
      title: payload.title,
      assistantId: payload.assistantId,
      isGroupChat: /^im-group/.test(payload.title ?? ''),
    };
  }

  fromChatContext(context: ChatCreateSessionContext): CreateSessionRequest {
    const imGroupId = context.imGroupId?.trim();
    if (imGroupId) {
      return {
        title: undefined,
        assistantId: context.assistantId,
        isGroupChat: true,
      };
    }

    return {
      title: undefined,
      assistantId: context.assistantId,
      isGroupChat: false,
    };
  }
}
