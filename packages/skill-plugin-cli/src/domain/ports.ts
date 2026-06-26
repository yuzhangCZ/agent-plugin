import type {
  CliQrSnapshot,
  HostAvailabilityResult,
  HostConfigureResult,
  HostPreflightResult,
  InstallContext,
  InstalledPluginArtifact,
  InstallHost,
  PresenterFailure,
} from "./types.ts";
import type { InstallStageKey } from "./stages.ts";

export interface ProcessExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProcessSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProcessCommandTrace {
  phase: "started" | "finished";
  command: string;
  args: string[];
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export interface ProcessTraceSink {
  push(trace: ProcessCommandTrace): void;
  drain(): ProcessCommandTrace[];
}

export interface ProcessRunner {
  exec(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<ProcessExecResult>;
  spawn(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<ProcessSpawnResult>;
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
  installStarted(input: {
    host: InstallContext["host"];
    packageName: string;
  }): void;
  hostVersionResolved(input: {
    host: InstallContext["host"];
    version: string;
  }): void;
  hostConfigPathResolved(input: {
    host: InstallContext["host"];
    primaryConfigPath: string;
  }): void;
  reinstallDetected(input: {
    host: InstallContext["host"];
  }): void;
  stageProgress(input: {
    host: InstallContext["host"];
    stage: InstallStageKey;
    status: "started" | "succeeded" | "failed";
    packageName?: string;
    verboseDetail?: string;
  }): void;
  installStrategyResolved(input: {
    strategy: InstallContext["installStrategy"];
  }): void;
  fallbackArtifactResolved(input: {
    artifact: InstalledPluginArtifact;
  }): void;
  fallbackApplied(input: {
    artifact: InstalledPluginArtifact;
  }): void;
  warningRaised(input: {
    message: string;
  }): void;
  commandBoundary(input: {
    phase: "started" | "finished";
    command: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  }): void;
  pluginInstalled(): void;
  qrSnapshot(snapshot: CliQrSnapshot): void;
  qrSnapshotDiagnostic(snapshot: unknown): void;
  assistantCreated(input: {
    host: InstallContext["host"];
    primaryConfigPath: string;
    additionalConfigPaths: string[];
  }): void;
  availabilityChecked(): void;
  completed(input: {
    host: InstallContext["host"];
    availability: HostAvailabilityResult;
  }): void;
  failed(input: PresenterFailure): void;
}

export interface QrCodeAuthPort {
  run(
    context: InstallContext,
    onSnapshot: (snapshot: CliQrSnapshot) => void,
    onDiagnostic?: (snapshot: unknown) => void,
  ): Promise<{ ak: string; sk: string }>;
}
