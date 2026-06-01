import { dirname, join, resolve } from 'path';
import { promises } from 'fs';
import type { BridgeConfig } from '../types/index.js';
import type { BridgeLogger } from '../runtime/AppLogger.js';
import { warnUnknownChannel } from '../runtime/ChannelWarning.js';
import { getErrorDetailsForLog, getErrorMessage } from '../utils/error.js';
import { JsoncParser } from './JsoncParser.js';
import { DEFAULT_BRIDGE_CONFIG } from './default-config.js';
import { resolveAuthCredentialPolicy } from './AuthCredentialPolicy.js';
import { EnvHostConfigLocator, type HostConfigLocator } from './HostConfigLocator.js';

const CONFIG_FILE_NAMES = ['message-bridge.jsonc', 'message-bridge.json'] as const;

type ConfigSourceKind = 'user' | 'project';

type LoadedConfigSource = {
  config: Partial<BridgeConfig>;
  kind: ConfigSourceKind;
  path: string;
  logMeta?: Record<string, unknown>;
};

export class ConfigResolver {
  private readonly jsoncParser: JsoncParser;
  private readonly logger?: BridgeLogger;
  private readonly hostConfigLocator: HostConfigLocator;

  constructor(logger?: BridgeLogger, hostConfigLocator: HostConfigLocator = new EnvHostConfigLocator()) {
    this.jsoncParser = new JsoncParser();
    this.logger = logger;
    this.hostConfigLocator = hostConfigLocator;
  }

  async resolveConfig(workspacePath?: string): Promise<BridgeConfig> {
    let config: Partial<BridgeConfig> = this.mergeConfig({}, DEFAULT_BRIDGE_CONFIG);
    const sources: string[] = ['default'];
    let channelSource: 'default' | 'user' | 'project' | 'env' = 'default';
    const workspaceRoot = workspacePath ?? process.cwd();
    this.logger?.info('config.resolve.started', { workspacePath: workspaceRoot });
    const userConfigLocation = this.hostConfigLocator.resolveUserConfigLocation();
    this.warnIgnoredUserConfigLocation(userConfigLocation);

    const userConfigPath = await this.findFirstExistingPath(
      this.getConfigCandidatePaths(userConfigLocation.dir),
    );
    const userSource = userConfigPath
      ? await this.loadConfigSource('user', userConfigPath, {
        userConfigSource: userConfigLocation.source,
        isolationEnabled: userConfigLocation.isolationEnabled,
      })
      : null;
    if (userSource) {
      ({ config, channelSource } = this.applyLoadedConfigSource(config, sources, channelSource, userSource));
    }

    const projectConfigPath = await this.findProjectConfig(workspaceRoot);
    const projectSource = projectConfigPath
      ? await this.loadConfigSource('project', projectConfigPath)
      : null;
    if (projectSource) {
      ({ config, channelSource } = this.applyLoadedConfigSource(config, sources, channelSource, projectSource));
    }

    ({ config, channelSource } = this.applyEnvConfigSource(config, sources, channelSource));

    const normalized = this.normalizeConfig(config as BridgeConfig);
    const gatewayChannel = this.readGatewayChannel(normalized);
    if (gatewayChannel) {
      warnUnknownChannel(this.logger, 'config.gateway.channel.unknown', gatewayChannel, {
        source: channelSource,
      });
    }
    this.logger?.info('config.resolve.completed', {
      workspacePath: workspaceRoot,
      sources,
      allowlistSize: this.readAllowlistSize(normalized),
      debugEnabled: !!normalized.debug,
      projectConfigPath,
    });
    return normalized;
  }

  private async loadConfigFile(filePath: string): Promise<Partial<BridgeConfig> | null> {
    try {
      return await this.jsoncParser.parseFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      this.logger?.error('config.source.load_failed', {
        path: filePath,
        error: getErrorMessage(error),
        ...getErrorDetailsForLog(error),
      });
      throw error;
    }
  }

  private warnIgnoredUserConfigLocation(
    userConfigLocation: ReturnType<HostConfigLocator['resolveUserConfigLocation']>,
  ): void {
    if (userConfigLocation.warningCode !== 'opencode_config_ignored_without_config_dir') {
      return;
    }
    this.logger?.warn('config.user_config.opencode_config_ignored', {
      opencodeConfig: userConfigLocation.opencodeConfig,
      resolvedUserConfigDir: userConfigLocation.dir,
    });
  }

  private async loadConfigSource(
    kind: ConfigSourceKind,
    path: string,
    logMeta?: Record<string, unknown>,
  ): Promise<LoadedConfigSource | null> {
    const config = await this.loadConfigFile(path);
    return config ? { config, kind, path, logMeta } : null;
  }

  private applyLoadedConfigSource(
    currentConfig: Partial<BridgeConfig>,
    sources: string[],
    currentChannelSource: 'default' | 'user' | 'project' | 'env',
    loaded: LoadedConfigSource,
  ): {
    config: Partial<BridgeConfig>;
    channelSource: 'default' | 'user' | 'project' | 'env';
  } {
    const config = this.mergeConfig(currentConfig, loaded.config);
    sources.push(`${loaded.kind}:${loaded.path}`);
    this.logger?.info('config.source.loaded', {
      source: loaded.kind,
      path: loaded.path,
      ...loaded.logMeta,
    });
    return {
      config,
      channelSource: this.hasConfiguredGatewayChannel(loaded.config) ? loaded.kind : currentChannelSource,
    };
  }

  private applyEnvConfigSource(
    currentConfig: Partial<BridgeConfig>,
    sources: string[],
    currentChannelSource: 'default' | 'user' | 'project' | 'env',
  ): {
    config: Partial<BridgeConfig>;
    channelSource: 'default' | 'user' | 'project' | 'env';
  } {
    const envConfig = this.loadEnvConfig();
    if (Object.keys(envConfig).length === 0) {
      return { config: currentConfig, channelSource: currentChannelSource };
    }
    sources.push('env');
    this.logger?.info('config.source.loaded', {
      source: 'env',
      overrideCount: Object.keys(envConfig).length,
    });
    return {
      config: this.mergeConfig(currentConfig, envConfig),
      channelSource: this.hasConfiguredGatewayChannel(envConfig) ? 'env' : currentChannelSource,
    };
  }

  private async findProjectConfig(startDir: string): Promise<string | null> {
    const configDirName = '.opencode';
    let current = resolve(startDir);

    while (true) {
      const configPath = await this.findFirstExistingPath(
        this.getConfigCandidatePaths(join(current, configDirName)),
      );
      if (configPath) {
        return configPath;
      }
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }

    return null;
  }

  private getConfigCandidatePaths(configDir: string): string[] {
    return CONFIG_FILE_NAMES.map((fileName) => join(configDir, fileName));
  }

  private async findFirstExistingPath(paths: string[]): Promise<string | null> {
    for (const path of paths) {
      try {
        await promises.access(path);
        return path;
      } catch {
        // Continue to the next candidate.
      }
    }
    return null;
  }

  private loadEnvConfig(): Partial<BridgeConfig> {
    const envConfig: Partial<BridgeConfig> = {};
    this.applyPrimitiveEnvConfig(envConfig);

    const gateway = this.readGatewayEnvConfig();
    if (gateway) {
      envConfig.gateway = gateway as unknown as BridgeConfig['gateway'];
    }

    if (this.shouldInjectEnvAuth()) {
      envConfig.auth = {
        ak: process.env.BRIDGE_AUTH_AK ? this.substituteEnvVars(process.env.BRIDGE_AUTH_AK) : '',
        sk: process.env.BRIDGE_AUTH_SK ? this.substituteEnvVars(process.env.BRIDGE_AUTH_SK) : '',
      };
    }

    const sdk = this.readSdkEnvConfig();
    if (sdk) {
      envConfig.sdk = sdk as unknown as BridgeConfig['sdk'];
    }

    if (process.env.BRIDGE_EVENTS_ALLOWLIST) {
      envConfig.events = {
        allowlist: process.env.BRIDGE_EVENTS_ALLOWLIST.split(',').map((item) => this.substituteEnvVars(item.trim())),
      };
    }

    return envConfig;
  }

  private applyPrimitiveEnvConfig(envConfig: Partial<BridgeConfig>): void {
    if (process.env.BRIDGE_ENABLED !== undefined) {
      envConfig.enabled = process.env.BRIDGE_ENABLED.toLowerCase() === 'true';
    }
    if (process.env.BRIDGE_DEBUG !== undefined) {
      envConfig.debug = process.env.BRIDGE_DEBUG.toLowerCase() === 'true';
    }
    const bridgeDirectory = process.env.BRIDGE_DIRECTORY?.trim();
    if (bridgeDirectory) {
      envConfig.bridgeDirectory = this.substituteEnvVars(bridgeDirectory);
    }
    if (process.env.BRIDGE_CONFIG_VERSION !== undefined) {
      envConfig.config_version = parseInt(process.env.BRIDGE_CONFIG_VERSION, 10);
    }
  }

  private readGatewayEnvConfig(): Record<string, unknown> | null {
    const gateway: Record<string, unknown> = {};
    this.applyGatewayIdentityEnv(gateway);
    this.applyGatewayReconnectEnv(gateway);
    this.applyGatewayHeartbeatEnv(gateway);
    return Object.keys(gateway).length > 0 ? gateway : null;
  }

  private applyGatewayIdentityEnv(gateway: Record<string, unknown>): void {
    if (process.env.BRIDGE_GATEWAY_URL) {
      gateway.url = this.substituteEnvVars(process.env.BRIDGE_GATEWAY_URL);
    }
    if (process.env.BRIDGE_GATEWAY_CHANNEL) {
      gateway.channel = this.substituteEnvVars(process.env.BRIDGE_GATEWAY_CHANNEL);
    }
  }

  private applyGatewayReconnectEnv(gateway: Record<string, unknown>): void {
    const reconnect: Record<string, unknown> = {};
    if (process.env.BRIDGE_GATEWAY_RECONNECT_BASE_MS) reconnect.baseMs = parseInt(process.env.BRIDGE_GATEWAY_RECONNECT_BASE_MS, 10);
    if (process.env.BRIDGE_GATEWAY_RECONNECT_MAX_MS) reconnect.maxMs = parseInt(process.env.BRIDGE_GATEWAY_RECONNECT_MAX_MS, 10);
    if (process.env.BRIDGE_GATEWAY_RECONNECT_EXPONENTIAL !== undefined) reconnect.exponential = process.env.BRIDGE_GATEWAY_RECONNECT_EXPONENTIAL.toLowerCase() === 'true';
    if (process.env.BRIDGE_GATEWAY_RECONNECT_JITTER) reconnect.jitter = process.env.BRIDGE_GATEWAY_RECONNECT_JITTER;
    if (process.env.BRIDGE_GATEWAY_RECONNECT_MAX_ELAPSED_MS) reconnect.maxElapsedMs = parseInt(process.env.BRIDGE_GATEWAY_RECONNECT_MAX_ELAPSED_MS, 10);
    if (Object.keys(reconnect).length > 0) gateway.reconnect = reconnect;
  }

  private applyGatewayHeartbeatEnv(gateway: Record<string, unknown>): void {
    const hb = process.env.BRIDGE_GATEWAY_HEARTBEAT_INTERVAL_MS ?? process.env.BRIDGE_EVENT_HEARTBEAT_INTERVAL_MS;
    if (hb) gateway.heartbeatIntervalMs = parseInt(hb, 10);
    if (process.env.BRIDGE_GATEWAY_PING_INTERVAL_MS) {
      gateway.ping = { intervalMs: parseInt(process.env.BRIDGE_GATEWAY_PING_INTERVAL_MS, 10) };
    }
  }

  private shouldInjectEnvAuth(): boolean {
    return resolveAuthCredentialPolicy({
      bridgeGatewayChannel: process.env.BRIDGE_GATEWAY_CHANNEL,
      authAk: process.env.BRIDGE_AUTH_AK,
      authSk: process.env.BRIDGE_AUTH_SK,
    }).shouldInjectEnvAuth;
  }

  private readSdkEnvConfig(): Record<string, unknown> | null {
    if (!process.env.BRIDGE_SDK_TIMEOUT_MS) {
      return null;
    }
    return { timeoutMs: parseInt(process.env.BRIDGE_SDK_TIMEOUT_MS, 10) };
  }

  private hasConfiguredGatewayChannel(config: Partial<BridgeConfig> | undefined | null): boolean {
    const channel = config?.gateway?.channel;
    return typeof channel === 'string' && channel.trim().length > 0;
  }

  private substituteEnvVars(value: string): string {
    return value.replace(/\$\{([^}]+)\}/g, (match, varName) => process.env[varName] || match);
  }

  private normalizeConfig(config: BridgeConfig): BridgeConfig {
    const normalized = { ...config };

    if (typeof normalized.bridgeDirectory === 'string') {
      const trimmed = normalized.bridgeDirectory.trim();
      normalized.bridgeDirectory = trimmed || undefined;
    }

    if (this.isRecord(normalized.gateway)) {
      normalized.gateway = { ...normalized.gateway };

      if (typeof normalized.gateway.channel === 'string') {
        normalized.gateway.channel = normalized.gateway.channel.trim();
      }
    }

    return normalized;
  }

  private readGatewayChannel(config: BridgeConfig): string | null {
    const gateway = config.gateway;
    if (!this.isRecord(gateway)) {
      return null;
    }

    const channel = gateway.channel;
    if (typeof channel !== 'string' || channel.length === 0) {
      return null;
    }

    return channel;
  }

  private readAllowlistSize(config: BridgeConfig): number {
    const events = config.events;
    if (!this.isRecord(events) || !Array.isArray(events.allowlist)) {
      return 0;
    }

    return events.allowlist.length;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private mergeConfig<T>(target: T, source: unknown): T {
    if (typeof target !== 'object' || typeof source !== 'object' || target === null || source === null) {
      return (source ?? target) as T;
    }

    const result = { ...(target as Record<string, unknown>) };
    for (const key of Object.keys(source as Record<string, unknown>)) {
      const src = (source as Record<string, unknown>)[key];
      const dst = result[key];

      if (typeof src === 'object' && src !== null && !Array.isArray(src)) {
        result[key] = this.mergeConfig(dst ?? {}, src);
      } else if (Array.isArray(src)) {
        result[key] = [...src];
      } else {
        result[key] = src;
      }
    }

    return result as T;
  }
}
