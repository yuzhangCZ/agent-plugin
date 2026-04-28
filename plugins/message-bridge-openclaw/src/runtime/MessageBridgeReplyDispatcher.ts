import { normalizeOutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";

type ReplyPayloadKind = "tool" | "block" | "final";

interface ReplyDeliveryInfo {
  kind: ReplyPayloadKind;
}

interface MessageBridgeReplyDispatcherParams {
  onReplyStart?: () => void;
  onBlock: (text: string) => void | Promise<void>;
  onFinal: (text: string) => void | Promise<void>;
  onTool: (text: string) => void | Promise<void>;
}

export interface MessageBridgeReplyDispatcher {
  onReplyStart(): void;
  deliver(rawPayload: unknown, info: ReplyDeliveryInfo): Promise<void>;
  sendToolResult(rawPayload: unknown): boolean;
  sendBlockReply(rawPayload: unknown): boolean;
  sendFinalReply(rawPayload: unknown): boolean;
  sendToolReply(rawPayload: unknown): boolean;
  waitForIdle(): Promise<void>;
  getQueuedCounts(): Record<ReplyPayloadKind, number>;
  markComplete(): void;
  markFullyComplete(): void;
  getPendingFinalText(): string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function createMessageBridgeReplyDispatcher(
  params: MessageBridgeReplyDispatcherParams,
): MessageBridgeReplyDispatcher {
  const queuedCounts: Record<ReplyPayloadKind, number> = {
    tool: 0,
    block: 0,
    final: 0,
  };
  let sendChain = Promise.resolve();
  let replyStarted = false;
  let completeCalled = false;
  let fullyClosed = false;
  let pendingFinalText: string | null = null;

  const startOnce = () => {
    if (replyStarted || fullyClosed) {
      return;
    }
    replyStarted = true;
    params.onReplyStart?.();
  };

  const normalizePayloadText = (rawPayload: unknown): string => {
    const payload = isRecord(rawPayload) ? normalizeOutboundReplyPayload(rawPayload) : normalizeOutboundReplyPayload({});
    return typeof payload.text === "string" ? payload.text : "";
  };

  const enqueue = (kind: ReplyPayloadKind, rawPayload: unknown): boolean => {
    if (fullyClosed) {
      return false;
    }

    const payloadText = kind === "tool" ? normalizePayloadText(rawPayload).trim() : normalizePayloadText(rawPayload);
    if (payloadText.length === 0) {
      return false;
    }

    queuedCounts[kind] += 1;
    startOnce();
    sendChain = sendChain
      .then(async () => {
        if (kind === "tool") {
          await params.onTool(payloadText);
          return;
        }
        if (kind === "final") {
          pendingFinalText = payloadText;
          await params.onFinal(payloadText);
          return;
        }
        await params.onBlock(payloadText);
      })
      .catch(() => {})
      .finally(() => {});

    return true;
  };

  const sendToolResult = (rawPayload: unknown): boolean => enqueue("tool", rawPayload);
  const sendBlockReply = (rawPayload: unknown): boolean => enqueue("block", rawPayload);
  const sendFinalReply = (rawPayload: unknown): boolean => enqueue("final", rawPayload);
  const sendToolReply = (rawPayload: unknown): boolean => sendToolResult(rawPayload);
  const markComplete = () => {
    if (completeCalled) {
      return;
    }
    completeCalled = true;
  };

  return {
    onReplyStart() {
      startOnce();
    },
    async deliver(rawPayload, info) {
      if (info.kind === "final") {
        await sendFinalReply(rawPayload);
        return;
      }
      if (info.kind === "tool") {
        await sendToolReply(rawPayload);
        return;
      }
      if (info.kind === "block") {
        sendBlockReply(rawPayload);
      }
    },
    sendToolResult,
    sendBlockReply,
    sendFinalReply,
    sendToolReply,
    async waitForIdle() {
      while (true) {
        const observedChain = sendChain;
        await observedChain;
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
        if (observedChain === sendChain) {
          if (completeCalled) {
            fullyClosed = true;
          }
          return;
        }
      }
    },
    getQueuedCounts() {
      return { ...queuedCounts };
    },
    markComplete,
    markFullyComplete() {
      fullyClosed = true;
      markComplete();
    },
    getPendingFinalText() {
      return pendingFinalText;
    },
  };
}
