import { InstallCliError, toInstallCliError } from "../domain/errors.ts";
import type { HostAdapter, Presenter, ProcessTraceSink, QrCodeAuthPort, RegistryConfigAdapter } from "../domain/ports.ts";
import { INSTALL_STAGE_KEYS, type InstallStageKey } from "../domain/stages.ts";
import type { CliQrFailureSummary, HostPreflightResult, InstallResult, ParsedInstallCommand, PresenterFailure } from "../domain/types.ts";
import { ResolveInstallContextUseCase } from "./ResolveInstallContextUseCase.ts";

function formatCommand(command: string, args: string[]) {
  return [command, ...args].join(" ");
}

export class InstallPluginCliUseCase {
  private readonly resolveContext: ResolveInstallContextUseCase;
  private readonly registryConfig: RegistryConfigAdapter;
  private readonly presenter: Presenter;
  private readonly qrCodeAuth: QrCodeAuthPort;
  private readonly hostAdapters: Record<"opencode" | "openclaw", HostAdapter>;
  private readonly traceSink: ProcessTraceSink;

  constructor(
    resolveContext: ResolveInstallContextUseCase,
    registryConfig: RegistryConfigAdapter,
    presenter: Presenter,
    qrCodeAuth: QrCodeAuthPort,
    hostAdapters: Record<"opencode" | "openclaw", HostAdapter>,
    traceSink: ProcessTraceSink,
  ) {
    this.resolveContext = resolveContext;
    this.registryConfig = registryConfig;
    this.presenter = presenter;
    this.qrCodeAuth = qrCodeAuth;
    this.hostAdapters = hostAdapters;
    this.traceSink = traceSink;
  }

  private emitStage(
    host: "opencode" | "openclaw",
    stage: InstallStageKey,
    status: "started" | "succeeded" | "failed",
    input: { packageName?: string; verboseDetail?: string } = {},
  ) {
    this.presenter.stageProgress({ host, stage, status, packageName: input.packageName, verboseDetail: input.verboseDetail });
  }

  private flushCommandTrace(verbose = false) {
    const traces = this.traceSink.drain();
    if (!verbose) {
      return;
    }
    for (const trace of traces) {
      this.presenter.commandBoundary({
        phase: trace.phase,
        command: formatCommand(trace.command, trace.args),
        stdout: trace.stdout,
        stderr: trace.stderr,
        exitCode: trace.exitCode,
      });
    }
  }

  private mapFailure(stage: InstallStageKey | undefined, error: InstallCliError): PresenterFailure {
    if (error.code === "QRCODE_AUTH_CANCELLED") {
      return {
        kind: "cancelled",
        message: error.message,
      };
    }
    if (error.code === "QRCODE_AUTH_FAILED") {
      let summary: CliQrFailureSummary = { type: "auth_service_error" };
      if (error.details) {
        try {
          summary = JSON.parse(error.details) as CliQrFailureSummary;
        } catch {
          summary = { type: "auth_service_error" };
        }
      }
      return {
        kind: "qrcode_error",
        message: error.message,
        summary,
      };
    }
    if (error.code === "INSTALLER_USAGE_ERROR") {
      return {
        kind: "usage_error",
        message: error.message,
        showHelpHint: true,
      };
    }
    return {
      kind: "install_error",
      stage,
      message: error.message,
    };
  }

  async execute(command: ParsedInstallCommand): Promise<InstallResult> {
    let currentStage: InstallStageKey | undefined = undefined;
    let contextHost = command.host;
    let preflight: HostPreflightResult | null = null;
    let nextSteps: string[] = [];
    let currentStageInput: { packageName?: string } = {};
    try {
      this.presenter.installStarted({
        host: command.host,
        packageName: this.hostAdapters[command.host].packageName,
      });

      currentStage = INSTALL_STAGE_KEYS[0];
      currentStageInput = {};
      if (command.verbose) {
        this.emitStage(command.host, currentStage, "started");
      }
      const context = await this.resolveContext.execute(command);
      contextHost = context.host;
      const resolutionSummary = [
        `environment=${context.environment}`,
        `registry=${context.registry}`,
        ...(context.url ? [`url=${context.url}`] : []),
      ].join(", ");
      if (context.verbose) {
        this.emitStage(context.host, currentStage, "succeeded", { verboseDetail: resolutionSummary });
      }

      const hostAdapter = this.hostAdapters[context.host];

      currentStage = INSTALL_STAGE_KEYS[1];
      currentStageInput = {};
      if (context.verbose) {
        this.emitStage(context.host, currentStage, "started");
      }
      preflight = await hostAdapter.preflight(context);
      this.flushCommandTrace(context.verbose);
      if (context.host === "openclaw" && preflight.version) {
        this.presenter.hostVersionResolved({
          host: context.host,
          version: preflight.version,
        });
      }
      if (preflight.versionSupported === false) {
        throw new InstallCliError(
          "OPENCLAW_VERSION_UNSUPPORTED",
          `当前 openclaw 版本 ${preflight.version ?? "unknown"} 不满足 >= ${preflight.minimumRequiredVersion ?? "unknown"}`,
        );
      }
      if (context.verbose) {
        this.emitStage(
          context.host,
          currentStage,
          "succeeded",
          { verboseDetail: preflight.version ? `version=${preflight.version}` : undefined },
        );
      }
      this.presenter.hostConfigPathResolved({
        host: context.host,
        primaryConfigPath: preflight.metadata.primaryConfigPath,
      });

      currentStage = INSTALL_STAGE_KEYS[2];
      currentStageInput = {};
      if (context.verbose) {
        this.emitStage(context.host, currentStage, "started");
      }
      await this.registryConfig.ensureRegistry(context.registry);
      if (context.verbose) {
        this.emitStage(context.host, currentStage, "succeeded");
      }

      currentStage = INSTALL_STAGE_KEYS[3];
      currentStageInput = { packageName: hostAdapter.packageName };
      if (context.verbose) {
        this.emitStage(context.host, currentStage, "started", currentStageInput);
      }
      await hostAdapter.installPlugin(context);
      this.flushCommandTrace(context.verbose);
      if (context.verbose) {
        this.emitStage(context.host, currentStage, "succeeded", currentStageInput);
      }
      this.presenter.pluginInstalled();

      currentStage = INSTALL_STAGE_KEYS[4];
      currentStageInput = {};
      if (context.verbose) {
        this.emitStage(context.host, currentStage, "started");
      }
      await hostAdapter.verifyPlugin(context);
      this.flushCommandTrace(context.verbose);
      if (context.verbose) {
        this.emitStage(context.host, currentStage, "succeeded");
      }

      currentStage = INSTALL_STAGE_KEYS[5];
      currentStageInput = {};
      if (context.verbose) {
        this.emitStage(context.host, currentStage, "started");
      }
      const credentials = await this.qrCodeAuth.run(context, (snapshot) => {
        this.presenter.qrSnapshot(snapshot);
      });
      if (context.verbose) {
        this.emitStage(context.host, currentStage, "succeeded");
      }

      currentStage = INSTALL_STAGE_KEYS[6];
      currentStageInput = {};
      if (context.verbose) {
        this.emitStage(context.host, currentStage, "started");
      }
      const configured = await hostAdapter.configureHost(context, credentials);
      this.flushCommandTrace(context.verbose);
      this.presenter.assistantCreated({
        host: context.host,
        primaryConfigPath: configured.primaryConfigPath,
        additionalConfigPaths: configured.additionalConfigPaths,
      });
      if (context.verbose) {
        this.emitStage(
          context.host,
          currentStage,
          "succeeded",
          configured.additionalConfigPaths.length > 0
            ? { verboseDetail: `additionalConfigPaths=${configured.additionalConfigPaths.join(", ")}` }
            : {},
        );
      }

      currentStage = INSTALL_STAGE_KEYS[7];
      currentStageInput = {};
      if (context.verbose) {
        this.emitStage(context.host, currentStage, "started");
      }
      const availability = await hostAdapter.confirmAvailability(context);
      this.flushCommandTrace(context.verbose);
      if (context.verbose) {
        this.emitStage(context.host, currentStage, "succeeded");
      }
      this.presenter.availabilityChecked();
      this.presenter.completed({
        host: context.host,
        availability,
      });

      if (availability.nextAction.kind === "restart_gateway") {
        nextSteps = [
          "下一步：请手动重启 openclaw gateway 以使新配置生效",
          ...(availability.nextAction.command ? [`可执行命令：${availability.nextAction.command}`] : []),
        ];
      } else {
        nextSteps = [`下一步：请重启 ${context.host} 以使插件与配置生效`];
      }
      return {
        status: "success",
        message: `${context.host} 已完成插件安装、助理创建与 gateway 配置`,
        nextSteps,
        warningMessages: [],
      };
    } catch (error) {
      const installError = toInstallCliError(error);
      this.flushCommandTrace(command.verbose ?? false);
      if (command.verbose && currentStage) {
        this.emitStage(contextHost, currentStage, "failed", {
          ...currentStageInput,
          verboseDetail: installError.message,
        });
      }
      const failure = this.mapFailure(currentStage, installError);
      this.presenter.failed(failure);
      if (failure.kind === "cancelled") {
        return {
          status: "cancelled",
          message: failure.message,
          nextSteps: [],
          warningMessages: [],
        };
      }
      return {
        status: "failed",
        message: installError.message,
        nextSteps: [],
        warningMessages: [],
      };
    }
  }
}
