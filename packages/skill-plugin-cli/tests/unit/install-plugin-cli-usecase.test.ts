import assert from "node:assert/strict";
import test from "node:test";
import { InstallPluginCliUseCase } from "../../src/application/InstallPluginCliUseCase.ts";
import { ResolveInstallContextUseCase } from "../../src/application/ResolveInstallContextUseCase.ts";
import type { HostAdapter, MacAddressResolver, Presenter, ProcessCommandTrace, ProcessTraceSink, QrCodeAuthPort, RegistryConfigAdapter } from "../../src/domain/ports.ts";
import type { HostAvailabilityResult, HostConfigureResult, HostPreflightResult, InstalledPluginArtifact, ParsedInstallCommand } from "../../src/domain/types.ts";
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

class EmptyTraceSink implements ProcessTraceSink {
  push(_trace: ProcessCommandTrace) {}

  drain() {
    return [];
  }
}

class RecordingPresenter implements Presenter {
  readonly warnings: string[] = [];
  readonly infos: string[] = [];
  readonly events: string[] = [];

  installStarted() {}
  hostVersionResolved() {}
  hostConfigPathResolved() {}
  reinstallDetected() {
    this.events.push("reinstall");
  }
  stageProgress(input: { verboseDetail?: string }) {
    if (input.verboseDetail) {
      this.infos.push(input.verboseDetail);
    }
  }
  installStrategyResolved(input: { strategy: "host-native" | "fallback" }) {
    this.infos.push(`strategy=${input.strategy}`);
  }
  fallbackArtifactResolved(input: { artifact: InstalledPluginArtifact }) {
    this.infos.push(`resolved=${input.artifact.packageName}`);
  }
  fallbackApplied(input: { artifact: InstalledPluginArtifact }) {
    this.infos.push(`applied=${input.artifact.pluginSpec}`);
  }
  warningRaised(input: { message: string }) {
    this.warnings.push(input.message);
    this.events.push(`warning=${input.message}`);
  }
  commandBoundary() {}
  pluginInstalled() {
    this.events.push("pluginInstalled");
  }
  qrSnapshot() {}
  assistantCreated() {}
  availabilityChecked() {}
  completed() {
    this.events.push("completed");
  }
  failed(input: { message: string }) {
    this.infos.push(input.message);
    this.events.push(`failed=${input.message}`);
  }
}

function createHostAdapter(options: {
  installResult?: InstalledPluginArtifact;
  installError?: Error;
  cleanupWarnings?: string[];
  verifySpy?: (artifact: InstalledPluginArtifact) => void;
  existingPluginDetected?: boolean;
}): HostAdapter {
  return {
    host: "opencode",
    packageName: "@wecode/skill-opencode-plugin",
    resolveDefaultUrl() {
      return "ws://localhost:8081/ws/agent";
    },
    async preflight(): Promise<HostPreflightResult> {
      return {
        metadata: {
          host: "opencode",
          hostDisplayName: "opencode",
          packageName: "@wecode/skill-opencode-plugin",
          primaryConfigPath: "/tmp/opencode.json",
        },
        existingPluginDetected: options.existingPluginDetected ?? false,
      };
    },
    async installPlugin() {
      if (options.installError) {
        throw options.installError;
      }
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
      return {
        primaryConfigPath: "/tmp/opencode.json",
        additionalConfigPaths: ["/tmp/message-bridge.json"],
      };
    },
    async confirmAvailability(): Promise<HostAvailabilityResult> {
      return {
        nextAction: {
          kind: "restart_host",
          manual: true,
          effect: "plugin_and_config_effective",
        },
      };
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
    new EmptyTraceSink(),
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
    verbose: true,
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
    existingPluginDetected: true,
  }), presenter);

  const result = await useCase.execute(createCommand("fallback"));
  assert.equal(result.status, "success");
  assert.equal(verifiedArtifact?.pluginSpec, "/tmp/plugin/package");
  assert.deepEqual(result.warningMessages, ["cleanup failed"]);
  assert.deepEqual(presenter.warnings, ["cleanup failed"]);
  assert.match(presenter.infos.join("\n"), /strategy=fallback/);
  assert.match(presenter.infos.join("\n"), /resolved=@wecode\/skill-opencode-plugin/);
  assert.deepEqual(presenter.events, ["reinstall", "warning=cleanup failed", "pluginInstalled", "completed"]);
});

test("InstallPluginCliUseCase fails host-native install without suggesting fallback retry", async () => {
  const presenter = new RecordingPresenter();
  const useCase = createUseCase(createHostAdapter({
    installError: new InstallCliError("PLUGIN_INSTALL_FAILED", "install failed"),
  }), presenter);

  const result = await useCase.execute(createCommand("host-native"));
  assert.equal(result.status, "failed");
  assert.doesNotMatch(presenter.infos.join("\n"), /resolved=/);
  assert.doesNotMatch(presenter.infos.join("\n"), /applied=/);
});
