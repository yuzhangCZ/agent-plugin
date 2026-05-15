import type { PluginRuntime } from "openclaw/plugin-sdk";

type GatewayRequester = {
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
};

export interface ApprovalResolveParams {
  permissionId: string;
  decision: "allow-once" | "allow-always" | "deny";
}

export interface ApprovalPort {
  resolve(params: ApprovalResolveParams): Promise<void>;
}

export interface QuestionReplyParams {
  requestId: string;
  answer: string;
}

export interface QuestionReplyPort {
  reply(params: QuestionReplyParams): Promise<void>;
}

function asGatewayRequester(value: unknown): GatewayRequester | null {
  if (
    value !== null &&
    typeof value === "object" &&
    "request" in value &&
    typeof (value as { request?: unknown }).request === "function"
  ) {
    return value as GatewayRequester;
  }
  return null;
}

function resolveGatewayRequester(runtime: PluginRuntime): GatewayRequester | null {
  const runtimeAny = runtime as PluginRuntime & {
    gatewayClient?: unknown;
    gateway?: unknown;
    request?: unknown;
  };

  return (
    asGatewayRequester(runtimeAny.gatewayClient) ??
    asGatewayRequester(runtimeAny.gateway) ??
    (typeof runtimeAny.request === "function"
      ? {
          request: async (method: string, params?: Record<string, unknown>) =>
            await (runtimeAny.request as (method: string, params?: Record<string, unknown>) => Promise<unknown>)(
              method,
              params,
            ),
        }
      : null)
  );
}

export class RuntimeApprovalPort implements ApprovalPort {
  constructor(private readonly runtime: PluginRuntime) {}

  async resolve(params: ApprovalResolveParams): Promise<void> {
    const gatewayRequester = resolveGatewayRequester(this.runtime);
    if (!gatewayRequester) {
      throw new Error("approval_runtime_unavailable");
    }

    await gatewayRequester.request("exec.approval.resolve", {
      id: params.permissionId,
      decision: params.decision,
    });
  }
}

export class RuntimeQuestionReplyPort implements QuestionReplyPort {
  constructor(private readonly runtime: PluginRuntime) {}

  async reply(params: QuestionReplyParams): Promise<void> {
    const runtimeAny = this.runtime as PluginRuntime & {
      question?: { reply?: (params: QuestionReplyParams) => Promise<void> };
      questions?: { reply?: (params: QuestionReplyParams) => Promise<void> };
    };

    const reply =
      runtimeAny.question?.reply ??
      runtimeAny.questions?.reply;

    if (!reply) {
      throw new Error("question_reply_unavailable_in_host");
    }

    await reply(params);
  }
}
