import { getCurrentRuntimeTraceId, getOrCreateRuntime } from './runtime/singleton.js';
import {
  configureMessageBridgeStatusLogger,
  getMessageBridgeStatus,
  subscribeMessageBridgeStatus,
} from './runtime/MessageBridgeStatusStore.js';
import { AppLogger } from './runtime/AppLogger.js';
import type { Plugin } from './runtime/types.js';
import { getErrorDetailsForLog, getErrorMessage } from './utils/error.js';

export const MessageBridgePlugin: Plugin = async (input) => {
  configureMessageBridgeStatusLogger(input.client, {
    runtimeTraceIdProvider: getCurrentRuntimeTraceId,
  });
  try {
    const runtime = await getOrCreateRuntime(input);
    const logger = new AppLogger(
      input.client,
      { component: 'plugin' },
      getCurrentRuntimeTraceId() ?? undefined,
    );
    if (!runtime) {
      logger.info('plugin.init.blocked_reinit_noop', {
        workspacePath: input.worktree || input.directory,
      });
      return {
        event: async () => {},
      };
    }

    return {
      event: async ({ event }) => {
        try {
          await runtime.handleEvent(event);
        } catch (error) {
          logger.error('plugin.event.failed_non_fatal', {
            eventType: typeof event?.type === 'string' ? event.type : 'unknown',
            error: getErrorMessage(error),
            ...getErrorDetailsForLog(error),
          });
        }
      },
    };
  } catch (error) {
    const logger = new AppLogger(
      input.client,
      { component: 'plugin' },
      getCurrentRuntimeTraceId() ?? undefined,
    );
    logger.error('plugin.init.failed_non_fatal', {
      workspacePath: input.worktree || input.directory,
      error: getErrorMessage(error),
      ...getErrorDetailsForLog(error),
    });
    return {
      event: async () => {},
    };
  }
};

export { getMessageBridgeStatus, subscribeMessageBridgeStatus };
export default MessageBridgePlugin;
