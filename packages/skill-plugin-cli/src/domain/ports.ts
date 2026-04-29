import type {
  CliQrSnapshot,
  HostAvailabilityResult,
  HostConfigureResult,
  HostPreflightResult,
  InstallContext,
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

export interface MacAddressResolver {
  resolve(): string;
}

export interface HostAdapter {
  readonly host: InstallContext["host"];
  readonly packageName: string;
  resolveDefaultUrl(): string;
  preflight(context: InstallContext): Promise<HostPreflightResult>;
  installPlugin(context: InstallContext): Promise<void>;
  verifyPlugin(context: InstallContext): Promise<void>;
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
  stageProgress(input: {
    host: InstallContext["host"];
    stage: InstallStageKey;
    status: "started" | "succeeded" | "failed";
    packageName?: string;
    verboseDetail?: string;
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
  run(context: InstallContext, onSnapshot: (snapshot: CliQrSnapshot) => void): Promise<{ ak: string; sk: string }>;
}
