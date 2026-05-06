import { INSTALL_STAGES } from "../domain/stages.ts";
import { toInstallCliError } from "../domain/errors.ts";
import type { HostAdapter, Presenter, QrCodeAuthPort, RegistryConfigAdapter } from "../domain/ports.ts";
import type { InstallContext, InstalledPluginArtifact, InstallResult, ParsedInstallCommand } from "../domain/types.ts";
import { ResolveInstallContextUseCase } from "./ResolveInstallContextUseCase.ts";

const SUCCESS_DETAIL_STAGES = new Set([
  INSTALL_STAGES[2],
  INSTALL_STAGES[6],
  INSTALL_STAGES[9],
]);

export class InstallPluginCliUseCase {
  private readonly resolveContext: ResolveInstallContextUseCase;
  private readonly registryConfig: RegistryConfigAdapter;
  private readonly presenter: Presenter;
  private readonly qrCodeAuth: QrCodeAuthPort;
  private readonly hostAdapters: Record<"opencode" | "openclaw", HostAdapter>;

  constructor(
    resolveContext: ResolveInstallContextUseCase,
    registryConfig: RegistryConfigAdapter,
    presenter: Presenter,
    qrCodeAuth: QrCodeAuthPort,
    hostAdapters: Record<"opencode" | "openclaw", HostAdapter>,
  ) {
    this.resolveContext = resolveContext;
    this.registryConfig = registryConfig;
    this.presenter = presenter;
    this.qrCodeAuth = qrCodeAuth;
    this.hostAdapters = hostAdapters;
  }

  async execute(command: ParsedInstallCommand): Promise<InstallResult> {
    let failureStage: (typeof INSTALL_STAGES)[number] = INSTALL_STAGES[0];
    const warningMessages: string[] = [];
    try {
      const bootstrapContext = {
        command: command.command,
        host: command.host,
        installStrategy: command.installStrategy,
        environment: command.environment ?? "prod",
        registry: command.registry ?? "",
        url: command.url ?? "",
        mac: "",
        channel: "openx" as const,
      };
      this.presenter.stageStarted(INSTALL_STAGES[0], bootstrapContext);

      failureStage = INSTALL_STAGES[1];
      this.presenter.stageStarted(INSTALL_STAGES[1], bootstrapContext);
      const context = await this.resolveContext.execute(command);
      const hostAdapter = this.hostAdapters[context.host];
      const resolutionSummary = [
        `environment=${context.environment}`,
        `installStrategy=${context.installStrategy}`,
        `registry=${context.registry}`,
        ...(context.url ? [`url=${context.url}`] : []),
      ].join(", ");
      this.presenter.stageSucceeded(INSTALL_STAGES[1], resolutionSummary);

      failureStage = INSTALL_STAGES[2];
      this.presenter.stageStarted(INSTALL_STAGES[2], context);
      const preflight = await hostAdapter.preflight(context);
      if (SUCCESS_DETAIL_STAGES.has(INSTALL_STAGES[2])) {
        this.presenter.stageSucceeded(INSTALL_STAGES[2], preflight.detail);
      }

      failureStage = INSTALL_STAGES[3];
      this.presenter.stageStarted(INSTALL_STAGES[3], context);
      const npmrc = await this.registryConfig.ensureRegistry(context.registry);
      void npmrc;

      failureStage = INSTALL_STAGES[4];
      this.presenter.stageStarted(INSTALL_STAGES[4], context);
      this.presenter.selectedInstallStrategy(context);
      this.presenter.info("正在执行宿主安装命令，以下输出来自宿主原生命令。");
      const artifact = await hostAdapter.installPlugin(context, this.presenter);
      if (artifact.installStrategy === "fallback") {
        this.presenter.fallbackArtifactResolved(artifact);
        this.presenter.fallbackApplied(artifact);
      }
      const cleanup = await hostAdapter.cleanupLegacyArtifacts(context);
      for (const warning of cleanup.warnings) {
        warningMessages.push(warning);
        this.presenter.warning(warning);
      }
      this.presenter.info("宿主安装命令执行结束。");

      failureStage = INSTALL_STAGES[5];
      this.presenter.stageStarted(INSTALL_STAGES[5], context);
      await hostAdapter.verifyPlugin(context, artifact);

      failureStage = INSTALL_STAGES[6];
      this.presenter.stageStarted(INSTALL_STAGES[6], context);
      const credentials = await this.qrCodeAuth.run(context, (snapshot) => {
        this.presenter.qrSnapshot(snapshot);
      });
      if (SUCCESS_DETAIL_STAGES.has(INSTALL_STAGES[6])) {
        this.presenter.stageSucceeded(INSTALL_STAGES[6], "已获取 AK/SK");
      }

      failureStage = INSTALL_STAGES[7];
      this.presenter.stageStarted(INSTALL_STAGES[7], context);
      const configured = await hostAdapter.configureHost(context, credentials);
      void configured;

      failureStage = INSTALL_STAGES[8];
      this.presenter.stageStarted(INSTALL_STAGES[8], context);
      const availability = await hostAdapter.confirmAvailability(context);
      void availability;

      failureStage = INSTALL_STAGES[9];
      this.presenter.stageStarted(INSTALL_STAGES[9], context);
      if (SUCCESS_DETAIL_STAGES.has(INSTALL_STAGES[9])) {
        this.presenter.stageSucceeded(INSTALL_STAGES[9], "流程已收口");
      }
      this.presenter.success(`${preflight.hostLabel} 安装完成`, availability.nextSteps);
      return {
        status: "success",
        message: `${preflight.hostLabel} 安装完成`,
        nextSteps: availability.nextSteps,
        warningMessages,
      };
    } catch (error) {
      const installError = toInstallCliError(error);
      this.presenter.stageFailed(failureStage, installError.message);
      if (installError.code === "QRCODE_AUTH_CANCELLED") {
        this.presenter.cancelled(installError.message);
        return {
          status: "cancelled",
          message: installError.message,
          nextSteps: [],
          warningMessages,
        };
      }
      this.presenter.failure(installError.message);
      return {
        status: "failed",
        message: installError.message,
        nextSteps: [],
        warningMessages,
      };
    }
  }
}
