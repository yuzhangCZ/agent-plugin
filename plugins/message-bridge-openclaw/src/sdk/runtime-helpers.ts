import type { PluginRuntime } from "openclaw/plugin-sdk";

type OpenClawChannelRuntime = NonNullable<PluginRuntime["channel"]>;
type OpenClawReplyRuntime = NonNullable<OpenClawChannelRuntime["reply"]>;
type OpenClawSessionRuntime = NonNullable<OpenClawChannelRuntime["session"]>;

export type ReplyAbortRuntime = {
  abortRun?(params: { sessionKey: string; runId?: string }): Promise<void>;
  cancelRun?(params: { sessionKey: string; runId?: string }): Promise<void>;
};

export type OpenClawPluginSdkModule = {
  createReplyPrefixOptions(input: unknown): {
    onModelSelected?: (selection: { provider: string; model: string; thinkLevel?: string }) => void;
    [key: string]: unknown;
  };
  normalizeOutboundReplyPayload(input: unknown): Record<string, unknown>;
};

const REQUIRED_REPLY_RUNTIME_METHODS = [
  "resolveEnvelopeFormatOptions",
  "formatAgentEnvelope",
  "finalizeInboundContext",
  "dispatchReplyWithBufferedBlockDispatcher",
] as const satisfies ReadonlyArray<keyof OpenClawReplyRuntime>;

type ReadyReplyRuntime = OpenClawReplyRuntime &
  Required<Pick<OpenClawReplyRuntime, (typeof REQUIRED_REPLY_RUNTIME_METHODS)[number]>>;

const REQUIRED_SESSION_RUNTIME_METHODS = [
  "resolveStorePath",
  "recordInboundSession",
] as const satisfies ReadonlyArray<keyof OpenClawSessionRuntime>;

type ReadySessionRuntime = OpenClawSessionRuntime &
  Required<Pick<OpenClawSessionRuntime, (typeof REQUIRED_SESSION_RUNTIME_METHODS)[number]>>;

export async function callRuntimeMethod<TArgs>(
  runtime: ReplyAbortRuntime,
  candidates: Array<keyof ReplyAbortRuntime>,
  args: TArgs,
): Promise<boolean> {
  for (const key of candidates) {
    const candidate = runtime[key];
    if (typeof candidate !== "function") {
      continue;
    }
    await (candidate as (input: TArgs) => Promise<void>)(args);
    return true;
  }
  return false;
}

export async function loadOpenClawPluginSdk(): Promise<OpenClawPluginSdkModule> {
  const [channelRuntime, replyPayload] = await Promise.all([
    import("openclaw/plugin-sdk/channel-runtime"),
    import("openclaw/plugin-sdk/reply-payload"),
  ]);
  return {
    createReplyPrefixOptions: channelRuntime.createReplyPrefixOptions,
    normalizeOutboundReplyPayload: replyPayload.normalizeOutboundReplyPayload,
  } as OpenClawPluginSdkModule;
}

function hasRuntimeMethods<T extends object, K extends keyof T>(
  value: T | null | undefined,
  methods: ReadonlyArray<K>,
): value is T & Required<Pick<T, K>> {
  return !!value && methods.every((method) => typeof value[method] === "function");
}

export function asReadyReplyRuntime(reply: OpenClawReplyRuntime | null | undefined): ReadyReplyRuntime | null {
  return hasRuntimeMethods(reply, REQUIRED_REPLY_RUNTIME_METHODS) ? reply : null;
}

export function asReadySessionRuntime(
  session: OpenClawSessionRuntime | null | undefined,
): ReadySessionRuntime | null {
  return hasRuntimeMethods(session, REQUIRED_SESSION_RUNTIME_METHODS) ? session : null;
}
