import type { QrCodeAuthEnvironment, QrCodeAuthSnapshot } from "./qrcode-types.ts";

export type InstallHost = "opencode" | "openclaw";
export type InstallCommand = "install";
export type InstallEnvironment = QrCodeAuthEnvironment;
export type InstallResultStatus = "success" | "failed" | "cancelled";
export type InstallStrategy = "host-native" | "fallback";

export interface ParsedInstallCommand {
  command: InstallCommand;
  host: InstallHost;
  installStrategy: InstallStrategy;
  environment?: InstallEnvironment;
  registry?: string;
  url?: string;
}

export interface InstallContext {
  command: InstallCommand;
  host: InstallHost;
  installStrategy: InstallStrategy;
  environment: InstallEnvironment;
  registry: string;
  url?: string;
  mac: string;
  channel: "openx";
}

export interface InstallResult {
  status: InstallResultStatus;
  message: string;
  nextSteps: string[];
  warningMessages: string[];
}

/**
 * 阶段 5 产出的标准化安装产物，后续阶段只能依赖该显式对象继续流转。
 */
export interface InstalledPluginArtifact {
  installStrategy: InstallStrategy;
  pluginSpec: string;
  packageName: string;
  packageVersion?: string;
  localExtractPath?: string;
  localTarballPath?: string;
}

export interface HostPreflightResult {
  hostLabel: string;
  detail: string;
}

export interface HostConfigureResult {
  detail: string;
}

export interface HostAvailabilityResult {
  detail: string;
  nextSteps: string[];
}

export interface QrCodeAuthOutcome {
  credentials: {
    ak: string;
    sk: string;
  };
  snapshots: QrCodeAuthSnapshot[];
}
