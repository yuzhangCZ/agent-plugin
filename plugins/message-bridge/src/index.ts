import { getOrCreateRuntime } from './runtime/singleton.js';
import { getMessageBridgeStatus, subscribeMessageBridgeStatus } from './runtime/MessageBridgeStatusStore.js';
import { AppLogger } from './runtime/AppLogger.js';
import type { Plugin } from './runtime/types.js';
import { getErrorDetailsForLog, getErrorMessage } from './utils/error.js';

export const MessageBridgePlugin: Plugin = async (input) => {
  const logger = new AppLogger(input.client, { component: 'plugin' });
  try {
    const runtime = await getOrCreateRuntime(input);

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
