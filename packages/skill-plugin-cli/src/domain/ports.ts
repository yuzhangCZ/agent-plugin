import type { QrCodeAuthSnapshot } from "./qrcode-types.ts";
import type {
  HostAvailabilityResult,
  HostConfigureResult,
  HostPreflightResult,
  InstallContext,
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
  stageStarted(stage: InstallStageName, context: InstallContext): void;
  stageSucceeded(stage: InstallStageName, detail?: string): void;
  stageFailed(stage: InstallStageName, message: string): void;
  info(message: string): void;
  qrSnapshot(snapshot: QrCodeAuthSnapshot): void;
  warning(message: string): void;
  success(summary: string, nextSteps?: string[]): void;
  failure(summary: string): void;
  cancelled(summary: string): void;
}

export interface QrCodeAuthPort {
  run(context: InstallContext, onSnapshot: (snapshot: QrCodeAuthSnapshot) => void): Promise<{ ak: string; sk: string }>;
}
