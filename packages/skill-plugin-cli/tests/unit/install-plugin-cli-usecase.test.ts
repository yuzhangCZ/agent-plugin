import assert from "node:assert/strict";
import test from "node:test";
import { InstallPluginCliUseCase } from "../../src/application/InstallPluginCliUseCase.ts";
import { ResolveInstallContextUseCase } from "../../src/application/ResolveInstallContextUseCase.ts";
import type { HostAdapter, Presenter, QrCodeAuthPort, RegistryConfigAdapter, MacAddressResolver } from "../../src/domain/ports.ts";
import type { HostAvailabilityResult, HostConfigureResult, HostPreflightResult, InstallContext, InstalledPluginArtifact, ParsedInstallCommand } from "../../src/domain/types.ts";
import { InstallCliError } from "../../src/domain/errors.ts";

class FakeRegistryConfigAdapter implements RegistryConfigAdapter {
  async resolveRegistry(preferredRegistry?: string) {
    return preferredRegistry || "https://npm.example.com";
  }
  async ensureRegistry() {
    return { path: "/tmp/.npmrc", changed: false };
  }
}

class FakeMacAddressResolver implements MacAddressResolver {
  resolve() {
    return "";
  }
}

class RecordingPresenter implements Presenter {
  readonly warnings: string[] = [];
  readonly infos: string[] = [];

  stageStarted() {}
  stageSucceeded(_stage: string, detail?: string) {
    if (detail) this.infos.push(detail);
  }
  stageFailed(_stage: string, message: string) {
    this.infos.push(message);
  }
  info(message: string) {
    this.infos.push(message);
  }
  qrSnapshot() {}
  warning(message: string) {
    this.warnings.push(message);
  }
  selectedInstallStrategy(context: InstallContext) {
    this.infos.push(`strategy=${context.installStrategy}`);
  }
  fallbackArtifactResolved(artifact: InstalledPluginArtifact) {
    this.infos.push(`resolved=${artifact.packageName}`);
  }
  fallbackApplied(artifact: InstalledPluginArtifact) {
    this.infos.push(`applied=${artifact.pluginSpec}`);
  }
  success(summary: string) {
    this.infos.push(summary);
  }
  failure(summary: string) {
    this.infos.push(summary);
  }
  cancelled(summary: string) {
    this.infos.push(summary);
  }
}

function createHostAdapter(options: {
  installResult?: InstalledPluginArtifact;
  installError?: Error;
  cleanupWarnings?: string[];
  verifySpy?: (artifact: InstalledPluginArtifact) => void;
}): HostAdapter {
  return {
    host: "opencode",
    packageName: "@wecode/skill-opencode-plugin",
    resolveDefaultUrl() {
      return "ws://localhost:8081/ws/agent";
    },
    async preflight(): Promise<HostPreflightResult> {
      return { hostLabel: "OpenCode", detail: "ok" };
    },
    async installPlugin() {
      if (options.installError) throw options.installError;
      return options.installResult || {
        installStrategy: "host-native",
        pluginSpec: "@wecode/skill-opencode-plugin",
        packageName: "@wecode/skill-opencode-plugin",
      };
    },
    async cleanupLegacyArtifacts() {
      return { warnings: options.cleanupWarnings || [] };
    },
    async verifyPlugin(_context, artifact) {
      options.verifySpy?.(artifact);
    },
    async configureHost(): Promise<HostConfigureResult> {
      return { detail: "configured" };
    },
    async confirmAvailability(): Promise<HostAvailabilityResult> {
      return { detail: "available", nextSteps: [] };
    },
  };
}

function createUseCase(hostAdapter: HostAdapter, presenter: RecordingPresenter) {
  const resolveContext = new ResolveInstallContextUseCase(
    new FakeRegistryConfigAdapter(),
    new FakeMacAddressResolver(),
    { opencode: hostAdapter, openclaw: hostAdapter as unknown as HostAdapter },
  );
  const qrCodeAuth: QrCodeAuthPort = {
    async run() {
      return { ak: "ak", sk: "sk" };
    },
  };
  return new InstallPluginCliUseCase(
    resolveContext,
    new FakeRegistryConfigAdapter(),
    presenter,
    qrCodeAuth,
    { opencode: hostAdapter, openclaw: hostAdapter as unknown as HostAdapter },
  );
}

function createCommand(installStrategy: "host-native" | "fallback"): ParsedInstallCommand {
  return {
    command: "install",
    host: "opencode",
    installStrategy,
    environment: "prod",
    registry: "https://npm.example.com",
    url: "wss://gateway.example.com/ws/agent",
  };
}

test("InstallPluginCliUseCase passes artifact from install stage into verify stage and aggregates warnings", async () => {
  let verifiedArtifact: InstalledPluginArtifact | null = null;
  const presenter = new RecordingPresenter();
  const useCase = createUseCase(createHostAdapter({
    installResult: {
      installStrategy: "fallback",
      pluginSpec: "/tmp/plugin/package",
      packageName: "@wecode/skill-opencode-plugin",
      packageVersion: "1.2.3",
      localExtractPath: "/tmp/plugin/package",
      localTarballPath: "/tmp/plugin.tgz",
    },
    cleanupWarnings: ["cleanup failed"],
    verifySpy: (artifact) => {
      verifiedArtifact = artifact;
    },
  }), presenter);

  const result = await useCase.execute(createCommand("fallback"));
  assert.equal(result.status, "success");
  assert.equal(verifiedArtifact?.pluginSpec, "/tmp/plugin/package");
  assert.deepEqual(result.warningMessages, ["cleanup failed"]);
  assert.deepEqual(presenter.warnings, ["cleanup failed"]);
  assert.match(presenter.infos.join("\n"), /resolved=@wecode\/skill-opencode-plugin/);
});

test("InstallPluginCliUseCase fails host-native install without suggesting fallback retry", async () => {
  const presenter = new RecordingPresenter();
  const useCase = createUseCase(createHostAdapter({
    installError: new InstallCliError("PLUGIN_INSTALL_FAILED", "install failed"),
  }), presenter);

  const result = await useCase.execute(createCommand("host-native"));
  assert.equal(result.status, "failed");
  assert.doesNotMatch(presenter.infos.join("\n"), /fallback/);
});
