import { createHash } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/**
 * 解析 AK scope 维度的 ownership 持久化文件路径。
 * @remarks 路径遵循设计文档的用户级 data-dir 模型，不依赖 workspace 或 bridge config 目录。
 */
export class AkScopedEntrySessionStorePathResolver {
  constructor(private readonly options: {
    dataDir?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  } = {}) {}

  resolve(input: { authAk: string }): string {
    const akScope = createHash('sha256').update(input.authAk).digest('hex');
    return join(this.resolveDataDir(), 'message-bridge', 'sessions', akScope, 'entry-session-store.json');
  }

  private resolveDataDir(): string {
    if (this.options.dataDir) {
      return this.options.dataDir;
    }
    const env = this.options.env ?? process.env;
    const currentPlatform = this.options.platform ?? platform();
    if (currentPlatform === 'darwin') {
      return join(homedir(), 'Library', 'Application Support');
    }
    if (currentPlatform === 'win32') {
      return env.LOCALAPPDATA && env.LOCALAPPDATA.trim().length > 0
        ? env.LOCALAPPDATA
        : join(homedir(), 'AppData', 'Local');
    }
    return env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim().length > 0
      ? env.XDG_DATA_HOME
      : join(homedir(), '.local', 'share');
  }
}
