import type { QrCodeAuthEnvironment, QrCodeAuthSnapshot } from "./qrcode-types.ts";

export type InstallHost = "opencode" | "openclaw";
export type InstallCommand = "install";
export type InstallEnvironment = QrCodeAuthEnvironment;
export type InstallResultStatus = "success" | "failed" | "cancelled";

export interface ParsedInstallCommand {
  command: InstallCommand;
  host: InstallHost;
  environment?: InstallEnvironment;
  registry?: string;
  url?: string;
}

export interface InstallContext {
  command: InstallCommand;
  host: InstallHost;
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
