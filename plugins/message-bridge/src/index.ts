import {
  cacheLoadedPluginInput,
  dispatchEventToActiveRuntime,
  getCurrentRuntimeTraceId,
  getOrCreateRuntime,
  startRuntimeFromLoadedInput,
  stopRuntime,
} from './runtime/singleton.js';
import {
  configureMessageBridgeStatusLogger,
  getMessageBridgeStatus,
  subscribeMessageBridgeStatus,
} from './runtime/MessageBridgeStatusStore.js';
import { AppLogger } from './runtime/AppLogger.js';
import type { Plugin } from './runtime/types.js';
import { getErrorDetailsForLog, getErrorMessage } from './utils/error.js';

export const MessageBridgePlugin: Plugin = async (input) => {
  cacheLoadedPluginInput(input);
  configureMessageBridgeStatusLogger(input.client, {
    runtimeTraceIdProvider: getCurrentRuntimeTraceId,
  });
  const createPluginLogger = () => new AppLogger(
    input.client,
    { component: 'plugin' },
    getCurrentRuntimeTraceId() ?? undefined,
  );
  try {
    const runtime = await getOrCreateRuntime(input);
    if (!runtime) {
      createPluginLogger().info('plugin.init.blocked_reinit_noop', {
        workspacePath: input.worktree || input.directory,
      });
    }
  } catch (error) {
    createPluginLogger().error('plugin.init.failed_non_fatal', {
      workspacePath: input.worktree || input.directory,
      error: getErrorMessage(error),
      ...getErrorDetailsForLog(error),
    });
  }

  return {
    event: async ({ event }) => {
      try {
        await dispatchEventToActiveRuntime(event);
      } catch (error) {
        createPluginLogger().error('plugin.event.failed_non_fatal', {
          eventType: typeof event?.type === 'string' ? event.type : 'unknown',
          error: getErrorMessage(error),
          ...getErrorDetailsForLog(error),
        });
      }
    },
  };
};

/**
 * 使用最近一次插件加载时保存的上下文，显式启动或重启 runtime。
 */
export async function startMessageBridgeRuntime(): Promise<void> {
  await startRuntimeFromLoadedInput();
}

/**
 * 显式停止当前 runtime，并将系统置于仅可通过显式 start 恢复的停机态。
 */
export function stopMessageBridgeRuntime(): void {
  stopRuntime();
}

export { getMessageBridgeStatus, subscribeMessageBridgeStatus };
export default MessageBridgePlugin;
