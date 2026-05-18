import type { ChannelSetupWizard } from "openclaw/plugin-sdk";
import {
  applyMessageBridgeSetupConfig,
  CHANNEL_ID,
  DEFAULT_ACCOUNT_ID,
  LEGACY_ACCOUNTS_MIGRATION_FIX,
  hasLegacyAccountsConfig,
  isAccountConfigured,
  resolveAccount,
  validateMessageBridgeSetupInput,
} from "./config.js";

const SETUP_TITLE = "Message Bridge setup";
const DEFAULT_GATEWAY_URL = "ws://localhost:8081/ws/agent";
const SETUP_INTRO = [
  "配置 ai-gateway 的 WebSocket 地址以及对应的 AK/SK。",
  "更新现有配置时，可以保留当前 AK/SK。",
].join("\n");

type GenericRecord = Record<string, unknown>;

function isRecord(value: unknown): value is GenericRecord {
  return value !== null && typeof value === "object";
}

function trimOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function resolveExplicitChannelField(cfg: unknown, ...path: string[]): string | undefined {
  let current: unknown = cfg;
  for (const key of ["channels", CHANNEL_ID, ...path]) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return trimOrUndefined(current);
}

function validateCurrentField(inputKey: string, value: string): string | undefined {
  const normalized = value.trim();

  if (inputKey === "name") {
    return undefined;
  }

  if (!normalized) {
    if (inputKey === "url") {
      return "Message Bridge 的 gateway.url 不能为空。";
    }
    if (inputKey === "token") {
      return "Message Bridge 的 auth.ak 不能为空。";
    }
    if (inputKey === "password") {
      return "Message Bridge 的 auth.sk 不能为空。";
    }
    return undefined;
  }

  if (inputKey !== "url") {
    return undefined;
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return "Message Bridge 的 gateway.url 必须使用 ws:// 或 wss://。";
    }
    return undefined;
  } catch {
    return "Message Bridge 的 gateway.url 不是合法的 WebSocket URL。";
  }
}

function applyWizardInput(params: {
  cfg: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["cfg"];
  input: {
    name?: string;
    url?: string;
    token?: string;
    password?: string;
  };
}) {
  return applyMessageBridgeSetupConfig({
    cfg: params.cfg,
    accountId: DEFAULT_ACCOUNT_ID,
    input: params.input,
  });
}

export function buildSelectionHint(configured: boolean, enabled: boolean, requiresMigration: boolean): string {
  if (requiresMigration) {
    return "migration required";
  }

  if (!configured) {
    return "not configured";
  }

  return enabled ? "configured" : "configured · disabled";
}

export function buildLegacyAccountsMessage(): string {
  return `检测到已废弃的 channels.${CHANNEL_ID}.accounts 配置。${LEGACY_ACCOUNTS_MIGRATION_FIX}`;
}

export const messageBridgeSetupWizard: ChannelSetupWizard = {
  channel: CHANNEL_ID,
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "not configured",
    resolveConfigured: ({ cfg }) => {
      const account = resolveAccount(cfg, DEFAULT_ACCOUNT_ID);
      return isAccountConfigured(account, cfg);
    },
    resolveStatusLines: ({ cfg, configured }) => {
      const account = resolveAccount(cfg, DEFAULT_ACCOUNT_ID);
      const requiresMigration = hasLegacyAccountsConfig(cfg);
      const status = buildSelectionHint(configured, account.enabled, requiresMigration);

      return [
        requiresMigration
          ? "Message Bridge: migration required"
          : `Message Bridge: ${status}${configured ? ` · ${account.gateway.url}` : ""}`,
        ...(account.name ? [`name: ${account.name}`] : []),
        ...(requiresMigration ? [LEGACY_ACCOUNTS_MIGRATION_FIX] : []),
      ];
    },
    resolveSelectionHint: ({ cfg, configured }) => {
      const account = resolveAccount(cfg, DEFAULT_ACCOUNT_ID);
      const requiresMigration = hasLegacyAccountsConfig(cfg);
      return buildSelectionHint(configured, account.enabled, requiresMigration);
    },
    resolveQuickstartScore: ({ cfg, configured }) => {
      if (!configured) {
        return 0;
      }
      return hasLegacyAccountsConfig(cfg) ? 0 : 1;
    },
  },
  introNote: {
    title: SETUP_TITLE,
    lines: SETUP_INTRO.split("\n"),
  },
  stepOrder: "text-first",
  credentials: [],
  textInputs: [
    {
      inputKey: "name",
      message: "Account name (optional)",
      placeholder: "Message Bridge",
      required: false,
      applyEmptyValue: true,
      currentValue: ({ cfg }) => resolveAccount(cfg, DEFAULT_ACCOUNT_ID).name,
      applySet: ({ cfg, value }) => applyWizardInput({ cfg, input: { name: value } }),
      validate: ({ value }) => validateCurrentField("name", value),
    },
    {
      inputKey: "url",
      message: "Gateway WebSocket URL",
      placeholder: DEFAULT_GATEWAY_URL,
      currentValue: ({ cfg }) => resolveExplicitChannelField(cfg, "gateway", "url"),
      keepPrompt: (value) => `Gateway WebSocket URL 已设置为 ${value}。保留它吗？`,
      applySet: ({ cfg, value }) => applyWizardInput({ cfg, input: { url: value } }),
      validate: ({ value }) => validateCurrentField("url", value),
    },
    {
      inputKey: "token",
      message: "AK",
      currentValue: ({ cfg }) => resolveExplicitChannelField(cfg, "auth", "ak"),
      keepPrompt: "AK 已配置。保留当前值吗？",
      applySet: ({ cfg, value }) => applyWizardInput({ cfg, input: { token: value } }),
      validate: ({ value }) => validateCurrentField("token", value),
    },
    {
      inputKey: "password",
      message: "SK",
      currentValue: ({ cfg }) => resolveExplicitChannelField(cfg, "auth", "sk"),
      keepPrompt: "SK 已配置。保留当前值吗？",
      applySet: ({ cfg, value }) => applyWizardInput({ cfg, input: { password: value } }),
      validate: ({ value }) => validateCurrentField("password", value),
    },
  ],
  prepare: ({ cfg }) => {
    if (hasLegacyAccountsConfig(cfg)) {
      throw new Error(buildLegacyAccountsMessage());
    }
  },
  finalize: ({ cfg }) => {
    const validationError = validateMessageBridgeSetupInput({
      cfg,
      accountId: DEFAULT_ACCOUNT_ID,
      input: {},
    });
    if (validationError) {
      throw new Error(validationError);
    }
    return { cfg };
  },
};
