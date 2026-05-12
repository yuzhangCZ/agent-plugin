import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { definePluginEntry, emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { messageBridgeSetupPlugin } from "./channel.setup.js";

export default definePluginEntry({
  id: "skill-openclaw-plugin",
  name: "Message Bridge",
  description: "Bridge ai-gateway sessions into OpenClaw",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: messageBridgeSetupPlugin });
  },
});
