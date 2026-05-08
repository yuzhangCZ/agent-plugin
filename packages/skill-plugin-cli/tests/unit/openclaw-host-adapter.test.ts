import assert from "node:assert/strict";
import test from "node:test";
import { OpenClawHostAdapter } from "../../src/adapters/OpenClawHostAdapter.ts";
import type { PluginArtifactPort, ProcessRunner } from "../../src/domain/ports.ts";

function createProcessRunner(version: string): ProcessRunner {
  return {
    async exec(command, args) {
      if (command === "openclaw" && args[0] === "--version") {
        return {
          stdout: version,
          stderr: "",
          exitCode: 0,
        };
      }
      return {
        stdout: "",
        stderr: "",
        exitCode: 1,
      };
    },
    async spawn() {
      return { stdout: "", stderr: "", exitCode: 0 };
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
      localExtractPath: "/tmp/plugin/package",
      localTarballPath: "/tmp/plugin.tgz",
    };
  },
};

test("OpenClawHostAdapter preflight accepts versions newer than the minimum runtime", async () => {
  const adapter = new OpenClawHostAdapter(createProcessRunner("2026.4.12"), noopArtifactPort);

  const result = await adapter.preflight({} as never);

  assert.equal(result.version, "2026.4.12");
  assert.equal(result.versionSupported, true);
  assert.equal(result.metadata.hostDisplayName, "openclaw");
  assert.match(result.metadata.primaryConfigPath, /openclaw\.json$/);
});

test("OpenClawHostAdapter preflight reports versions older than the minimum runtime", async () => {
  const adapter = new OpenClawHostAdapter(createProcessRunner("2026.3.23"), noopArtifactPort);

  const result = await adapter.preflight({} as never);

  assert.equal(result.version, "2026.3.23");
  assert.equal(result.versionSupported, false);
  assert.equal(result.minimumRequiredVersion, "2026.3.24");
});

test("OpenClawHostAdapter confirmAvailability returns manual gateway restart next steps after probe", async () => {
  const adapter = new OpenClawHostAdapter(createProcessRunner("2026.4.12"), noopArtifactPort);

  const result = await adapter.confirmAvailability({} as never);

  assert.deepEqual(result, {
    nextAction: {
      kind: "restart_gateway",
      manual: true,
      effect: "gateway_config_effective",
      command: "openclaw gateway restart",
    },
  });
});

test("OpenClawHostAdapter fallback install uses local tarball path", async () => {
  const spawnCalls: Array<{ command: string; args: string[] }> = [];
  const processRunner: ProcessRunner = {
    async exec(command, args) {
      if (command === "openclaw" && args[0] === "--version") {
        return { stdout: "2026.4.12", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    },
    async spawn(command, args) {
      spawnCalls.push({ command, args });
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async spawnDetached() {
      return;
    },
  };
  const adapter = new OpenClawHostAdapter(processRunner, noopArtifactPort);

  const artifact = await adapter.installPlugin({
    command: "install",
    host: "openclaw",
    installStrategy: "fallback",
    environment: "prod",
    registry: "https://npm.example.com",
    mac: "",
    channel: "openx",
    verbose: false,
  });

  assert.equal(artifact.localTarballPath, "/tmp/plugin.tgz");
  assert.deepEqual(spawnCalls.at(-1), {
    command: "openclaw",
    args: ["plugins", "install", "/tmp/plugin.tgz"],
  });
});
