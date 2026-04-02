import { homedir } from 'os';
import { join, resolve } from 'path';

export interface HostConfigLocator {
  resolveUserConfigLocation(): UserConfigLocation;
}

interface EnvHostConfigLocatorOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface UserConfigLocation {
  dir: string;
  source: 'default' | 'opencode_config_dir';
  isolationEnabled: boolean;
  warningCode?: 'opencode_config_ignored_without_config_dir';
  opencodeConfig?: string;
}

export class EnvHostConfigLocator implements HostConfigLocator {
  private readonly env: NodeJS.ProcessEnv;
  private readonly homeDir: string;

  constructor(options: EnvHostConfigLocatorOptions = {}) {
    this.env = options.env ?? process.env;
    this.homeDir = options.homeDir ?? this.env.HOME ?? homedir();
  }

  resolveUserConfigLocation(): UserConfigLocation {
    const configDir = this.readTrimmedEnv('OPENCODE_CONFIG_DIR');
    if (configDir) {
      return {
        dir: resolve(configDir),
        source: 'opencode_config_dir',
        isolationEnabled: true,
      };
    }

    const defaultDir = join(this.homeDir, '.config', 'opencode');
    const opencodeConfig = this.readTrimmedEnv('OPENCODE_CONFIG');

    return {
      dir: defaultDir,
      source: 'default',
      isolationEnabled: false,
      ...(opencodeConfig
        ? {
            warningCode: 'opencode_config_ignored_without_config_dir' as const,
            opencodeConfig,
          }
        : {}),
    };
  }

  private readTrimmedEnv(key: 'OPENCODE_CONFIG' | 'OPENCODE_CONFIG_DIR'): string | undefined {
    const value = this.env[key]?.trim();
    return value ? value : undefined;
  }
}
