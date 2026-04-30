import assert from "node:assert/strict";
import test from "node:test";
import { OpenClawHostAdapter } from "../../src/adapters/OpenClawHostAdapter.ts";
import { InstallCliError } from "../../src/domain/errors.ts";
import type { PluginArtifactPort, ProcessRunner } from "../../src/domain/ports.ts";

function createProcessRunner(
  version: string,
  commandLog: string[] = [],
  options: {
    pluginInfoExitCode?: number;
    pluginInfoStdout?: string;
    pluginInfoStderr?: string;
    uninstallExitCode?: number;
  } = {},
): ProcessRunner {
  return {
    async exec(command, args) {
      commandLog.push(`${command} ${args.join(" ")}`);
      if (command === "openclaw" && args[0] === "--version") {
        return { stdout: version, stderr: "", exitCode: 0 };
      }
      if (command === "openclaw" && args[0] === "plugins" && args[1] === "info") {
        return {
          stdout: options.pluginInfoStdout ?? '{"id":"skill-openclaw-plugin","channelIds":["message-bridge"]}',
          stderr: options.pluginInfoStderr ?? "",
          exitCode: options.pluginInfoExitCode ?? 0,
        };
      }
      if (command === "openclaw" && args[0] === "channels" && args[1] === "status") {
        return { stdout: '{"state":"ready"}', stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async spawn(command, args) {
      commandLog.push(`${command} ${args.join(" ")}`);
      if (command === "openclaw" && args[0] === "plugins" && args[1] === "uninstall") {
        return { exitCode: options.uninstallExitCode ?? 0 };
      }
      return { exitCode: 0 };
    },
    async spawnDetached() {
      return;
    },
  };
}

const noopArtifactPort: PluginArtifactPort = {
  async fetchArtifact() {
    return {
      installStrategy: "fallback",
      pluginSpec: "@wecode/skill-openclaw-plugin",
      packageName: "@wecode/skill-openclaw-plugin",
      packageVersion: "1.2.3",
      localTarballPath: "/tmp/skill-openclaw-plugin-1.2.3.tgz",
      localExtractPath: "/tmp/package",
    };
  },
};

test("OpenClawHostAdapter preflight accepts versions newer than the minimum runtime", async () => {
  const adapter = new OpenClawHostAdapter(createProcessRunner("2026.4.12"), noopArtifactPort);
  const result = await adapter.preflight({
    command: "install",
    host: "openclaw",
    installStrategy: "host-native",
    environment: "prod",
    registry: "https://npm.example.com",
    mac: "",
    channel: "openx",
  });
  assert.match(result.detail, /2026\.4\.12/);
});

test("OpenClawHostAdapter preflight rejects versions older than the minimum runtime", async () => {
  const adapter = new OpenClawHostAdapter(createProcessRunner("2026.3.23"), noopArtifactPort);
  await assert.rejects(
    async () => {
      await adapter.preflight({
        command: "install",
        host: "openclaw",
        installStrategy: "host-native",
        environment: "prod",
        registry: "https://npm.example.com",
        mac: "",
        channel: "openx",
      });
    },
    (error) => error instanceof InstallCliError && error.code === "OPENCLAW_VERSION_UNSUPPORTED",
  );
});

test("OpenClawHostAdapter fallback install uses local tgz", async () => {
  const commandLog: string[] = [];
  const adapter = new OpenClawHostAdapter(createProcessRunner("2026.4.12", commandLog), noopArtifactPort);
  const artifact = await adapter.installPlugin({
    command: "install",
    host: "openclaw",
    installStrategy: "fallback",
    environment: "prod",
    registry: "https://npm.example.com",
    mac: "",
    channel: "openx",
  }, { info() {} });
  assert.equal(artifact.localTarballPath, "/tmp/skill-openclaw-plugin-1.2.3.tgz");
  assert.match(commandLog.join("\n"), /openclaw plugins info skill-openclaw-plugin --json/);
  assert.match(commandLog.join("\n"), /openclaw plugins uninstall skill-openclaw-plugin --force/);
  assert.match(commandLog.join("\n"), /openclaw plugins install \/tmp\/skill-openclaw-plugin-1\.2\.3\.tgz/);
});

test("OpenClawHostAdapter skips uninstall when install probe exits non-zero", async () => {
  const commandLog: string[] = [];
  const adapter = new OpenClawHostAdapter(createProcessRunner("2026.4.12", commandLog, {
    pluginInfoExitCode: 1,
    pluginInfoStderr: "Plugin not found",
  }), noopArtifactPort);
  await adapter.installPlugin({
    command: "install",
    host: "openclaw",
    installStrategy: "host-native",
    environment: "prod",
    registry: "https://npm.example.com",
    mac: "",
    channel: "openx",
  }, { info() {} });
  assert.match(commandLog.join("\n"), /openclaw plugins info skill-openclaw-plugin --json/);
  assert.doesNotMatch(commandLog.join("\n"), /plugins uninstall/);
  assert.match(commandLog.join("\n"), /openclaw plugins install @wecode\/skill-openclaw-plugin/);
});

test("OpenClawHostAdapter fails when uninstall exits non-zero", async () => {
  const commandLog: string[] = [];
  const adapter = new OpenClawHostAdapter(createProcessRunner("2026.4.12", commandLog, {
    uninstallExitCode: 7,
  }), noopArtifactPort);
  await assert.rejects(
    async () => {
      await adapter.installPlugin({
        command: "install",
        host: "openclaw",
        installStrategy: "host-native",
        environment: "prod",
        registry: "https://npm.example.com",
        mac: "",
        channel: "openx",
      }, { info() {} });
    },
    (error) => error instanceof InstallCliError && error.code === "PLUGIN_INSTALL_FAILED",
  );
  assert.match(commandLog.join("\n"), /openclaw plugins uninstall skill-openclaw-plugin --force/);
  assert.doesNotMatch(commandLog.join("\n"), /plugins install @wecode\/skill-openclaw-plugin/);
});

test("OpenClawHostAdapter verifyPlugin fails when info exits non-zero", async () => {
  const adapter = new OpenClawHostAdapter(createProcessRunner("2026.4.12", [], {
    pluginInfoExitCode: 3,
    pluginInfoStderr: "query failed",
  }), noopArtifactPort);
  await assert.rejects(
    async () => {
      await adapter.verifyPlugin({
        command: "install",
        host: "openclaw",
        installStrategy: "host-native",
        environment: "prod",
        registry: "https://npm.example.com",
        mac: "",
        channel: "openx",
      }, {
        installStrategy: "host-native",
        pluginSpec: "@wecode/skill-openclaw-plugin",
        packageName: "@wecode/skill-openclaw-plugin",
      });
    },
    (error) => error instanceof InstallCliError && error.code === "PLUGIN_INSTALL_VERIFICATION_FAILED",
  );
});

test("OpenClawHostAdapter confirmAvailability returns manual gateway restart next steps after probe", async () => {
  const adapter = new OpenClawHostAdapter(createProcessRunner("2026.4.12"), noopArtifactPort);
  const result = await adapter.confirmAvailability();
  assert.equal(result.detail, "探活通过，channel 已可用。");
  assert.deepEqual(result.nextSteps, [
    "下一步：请手动重启 OpenClaw gateway 以确认 channel 生效。",
    "可执行命令：openclaw gateway restart",
  ]);
});
