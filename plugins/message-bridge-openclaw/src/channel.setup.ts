import type { ChannelPlugin } from "openclaw/plugin-sdk";
import { messageBridgeConfigAdapter, messageBridgeConfigSchema, messageBridgeCapabilities, messageBridgeMeta, messageBridgeSetupAdapter } from "./channel.shared.js";
import { messageBridgeSetupWizard } from "./setup-wizard.js";
import type { MessageBridgeResolvedAccount } from "./types.js";

export const messageBridgeSetupPlugin: Pick<
  ChannelPlugin<MessageBridgeResolvedAccount>,
  "id" | "meta" | "capabilities" | "config" | "configSchema" | "setup" | "setupWizard"
> = {
  id: messageBridgeMeta.id,
  meta: messageBridgeMeta,
  capabilities: messageBridgeCapabilities,
  configSchema: messageBridgeConfigSchema,
  config: messageBridgeConfigAdapter,
  setup: messageBridgeSetupAdapter,
  setupWizard: messageBridgeSetupWizard,
};
