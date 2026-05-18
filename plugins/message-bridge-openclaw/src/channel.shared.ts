import type {
  ChannelConfigSchema,
  ChannelPlugin,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import { applyAccountNameToChannelSection } from "openclaw/plugin-sdk/core";
import {
  applyMessageBridgeSetupConfig,
  CHANNEL_ID,
  DEFAULT_ACCOUNT_ID,
  deleteMessageBridgeAccount,
  describeAccount,
  isAccountConfigured,
  listAccountIds,
  resolveAccount,
  resolveSupportedAccountId,
  resolveUnconfiguredReason,
  setMessageBridgeAccountEnabled,
  validateMessageBridgeSetupInput,
} from "./config.js";
import type { MessageBridgeResolvedAccount } from "./types.js";

export const messageBridgeConfigSchema: ChannelConfigSchema = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      debug: { type: "boolean" },
      streaming: { type: "boolean" },
      name: { type: "string", minLength: 1 },
      gateway: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", minLength: 1 },
          heartbeatIntervalMs: { type: "integer", minimum: 1 },
          reconnect: {
            type: "object",
            additionalProperties: false,
            properties: {
              baseMs: { type: "integer", minimum: 1 },
              maxMs: { type: "integer", minimum: 1 },
              exponential: { type: "boolean" },
            },
          },
        },
        required: ["url"],
      },
      auth: {
        type: "object",
        additionalProperties: false,
        properties: {
          ak: { type: "string", minLength: 1 },
          sk: { type: "string", minLength: 1 },
        },
        required: ["ak", "sk"],
      },
      agentIdPrefix: { type: "string", minLength: 1 },
      runTimeoutMs: { type: "integer", minimum: 1_000 },
    },
    required: ["gateway", "auth"],
  },
  uiHints: {
    "auth.ak": {
      label: "AK",
      sensitive: true,
    },
    "auth.sk": {
      label: "SK",
      sensitive: true,
    },
  },
};

export const messageBridgeMeta = {
  id: CHANNEL_ID,
  label: "Message Bridge",
  selectionLabel: "Message Bridge",
  docsPath: "/channels/message-bridge",
  blurb: "Bridge ai-gateway sessions into OpenClaw.",
} as const;

export const messageBridgeCapabilities = {
  chatTypes: ["direct"],
  nativeCommands: false,
  blockStreaming: true,
} as const;

export const messageBridgeConfigAdapter: ChannelPlugin<MessageBridgeResolvedAccount>["config"] = {
  listAccountIds: (cfg: OpenClawConfig) => listAccountIds(cfg),
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => resolveAccount(cfg, accountId),
  defaultAccountId: () => DEFAULT_ACCOUNT_ID,
  setAccountEnabled: ({ cfg, accountId, enabled }) =>
    setMessageBridgeAccountEnabled({
      cfg,
      accountId,
      enabled,
    }),
  deleteAccount: ({ cfg, accountId }) =>
    deleteMessageBridgeAccount({
      cfg,
      accountId,
    }),
  isEnabled: (account) => account.enabled,
  disabledReason: () => "disabled",
  isConfigured: (account, cfg) => isAccountConfigured(account, cfg),
  unconfiguredReason: (_account, cfg) => resolveUnconfiguredReason(cfg),
  describeAccount: (account, cfg) => describeAccount(account, cfg),
};

export const messageBridgeSetupAdapter: ChannelPlugin<MessageBridgeResolvedAccount>["setup"] = {
  resolveAccountId: ({ accountId }) => resolveSupportedAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: CHANNEL_ID,
      accountId,
      name,
    }),
  validateInput: ({ cfg, accountId, input }) =>
    validateMessageBridgeSetupInput({
      cfg,
      accountId,
      input,
    }),
  applyAccountConfig: ({ cfg, accountId, input }) =>
    applyMessageBridgeSetupConfig({
      cfg,
      accountId,
      input,
    }),
};
