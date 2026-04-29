import type { QrCodeAuthSnapshot } from "./qrcode-types.ts";
import type {
  HostAvailabilityResult,
  HostConfigureResult,
  HostPreflightResult,
  InstallContext,
  InstalledPluginArtifact,
  InstallHost,
} from "./types.ts";
import type { InstallStageName } from "./stages.ts";

export interface ProcessExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProcessSpawnResult {
  exitCode: number;
}

export interface ProcessRunner {
  exec(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<ProcessExecResult>;
  spawn(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: "inherit" | "pipe" }): Promise<ProcessSpawnResult>;
  spawnDetached(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<void>;
}

export interface RegistryConfigAdapter {
  resolveRegistry(preferredRegistry?: string): Promise<string>;
  ensureRegistry(registry: string): Promise<{ path: string; changed: boolean }>;
}

/**
 * 统一发布包获取端口，负责 fallback 所需的取包、缓存与完整性校验。
 */
export interface PluginArtifactPort {
  fetchArtifact(input: {
    host: InstallHost;
    installStrategy: InstallContext["installStrategy"];
    packageName: string;
    registry: string;
  }): Promise<InstalledPluginArtifact>;
}

export interface MacAddressResolver {
  resolve(): string;
}

export interface HostAdapter {
  readonly host: InstallContext["host"];
  readonly packageName: string;
  resolveDefaultUrl(): string;
  preflight(context: InstallContext): Promise<HostPreflightResult>;
  installPlugin(context: InstallContext): Promise<InstalledPluginArtifact>;
  cleanupLegacyArtifacts(context: InstallContext): Promise<{ warnings: string[] }>;
  verifyPlugin(context: InstallContext, artifact: InstalledPluginArtifact): Promise<void>;
  configureHost(context: InstallContext, credentials: { ak: string; sk: string }): Promise<HostConfigureResult>;
  confirmAvailability(context: InstallContext): Promise<HostAvailabilityResult>;
}

export interface Presenter {
  stageStarted(stage: InstallStageName, context: InstallContext): void;
  stageSucceeded(stage: InstallStageName, detail?: string): void;
  stageFailed(stage: InstallStageName, message: string): void;
  info(message: string): void;
  qrSnapshot(snapshot: QrCodeAuthSnapshot): void;
  warning(message: string): void;
  selectedInstallStrategy(context: InstallContext): void;
  fallbackArtifactResolved(artifact: InstalledPluginArtifact): void;
  fallbackApplied(artifact: InstalledPluginArtifact): void;
  success(summary: string, nextSteps?: string[]): void;
  failure(summary: string): void;
  cancelled(summary: string): void;
}

export interface QrCodeAuthPort {
  run(context: InstallContext, onSnapshot: (snapshot: QrCodeAuthSnapshot) => void): Promise<{ ak: string; sk: string }>;
}
