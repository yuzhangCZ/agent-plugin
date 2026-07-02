
import type { Event as OpenCodeSdkV2Event } from '@opencode-ai/sdk/v2' with { 'resolution-mode': 'import' };


/**
 * OpenCode 宿主可能投递到插件 hook 的全量事件边界。
 * @remarks message-bridge 只支持其中一部分事件；routing/translation 层负责收窄和 fail-closed drop。
 */
export type BridgeEvent = OpenCodeSdkV2Event;

export interface PluginInput {
  client: unknown;
  directory?: string;
  worktree?: string;
}

export interface Hooks {
  event?: (input: { event: BridgeEvent }) => Promise<void> | void;
}

export type Plugin = (input: PluginInput) => Promise<Hooks> | Hooks;
