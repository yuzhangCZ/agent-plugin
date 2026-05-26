import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 解析 AK scope 维度的 ownership 持久化文件路径。
 * @remarks 默认使用跨平台一致的 Unix 风格用户数据目录，不依赖 workspace、bridge config 或系统平台 data dir。
 */
export class AkScopedEntrySessionStorePathResolver {
  constructor(private readonly options: {
    dataDir?: string;
  } = {}) {}

  resolve(input: { authAk: string }): string {
    const akScope = createHash('sha256').update(input.authAk).digest('hex');
    return join(this.resolveDataDir(), 'message-bridge', 'sessions', akScope, 'entry-session-store.json');
  }

  private resolveDataDir(): string {
    if (this.options.dataDir) {
      return this.options.dataDir;
    }
    return join(homedir(), '.local', 'share');
  }
}
