import type { QrCodeAuthEnvironment, QrCodeAuthSnapshot } from "./qrcode-types.ts";
import type { InstallStageKey } from "./stages.ts";

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
  verbose?: boolean;
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
  verbose: boolean;
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
  metadata: HostMetadata;
  version?: string;
  versionSupported?: boolean;
  minimumRequiredVersion?: string;
}

export interface HostConfigureResult {
  primaryConfigPath: string;
  additionalConfigPaths: string[];
}

export interface HostAvailabilityResult {
  nextAction: {
    kind: "restart_host" | "restart_gateway";
    manual: boolean;
    effect: "gateway_config_effective" | "plugin_and_config_effective";
    command?: string;
  };
}

export interface QrCodeAuthOutcome {
  credentials: {
    ak: string;
    sk: string;
  };
  snapshots: QrCodeAuthSnapshot[];
}

export interface HostMetadata {
  host: InstallHost;
  hostDisplayName: InstallHost;
  packageName: string;
  primaryConfigPath: string;
}

export type CliQrFailureSummary =
  | { type: "network_error"; code?: string; message?: string }
  | { type: "auth_service_error"; businessCode?: string; error?: string; message?: string; httpStatus?: number };

export type CliQrSnapshot =
  | {
      type: "qrcode_generated";
      weUrl: string;
      pcUrl: string;
      expiresAt: string;
      refresh?: { index: number; max: number };
    }
  | { type: "expired" }
  | { type: "confirmed" }
  | { type: "cancelled"; message: string }
  | { type: "failed"; message: string; summary: CliQrFailureSummary };

export type PresenterFailure =
  | {
      kind: "usage_error";
      message: string;
      showHelpHint: true;
    }
  | {
      kind: "qrcode_error";
      message: string;
      summary: CliQrFailureSummary;
      verboseMessage?: string;
    }
  | {
      kind: "cancelled";
      message: string;
    }
  | {
      kind: "install_error";
      stage?: InstallStageKey;
      message: string;
      verboseMessage?: string;
      additionalConfigPaths?: string[];
    };
