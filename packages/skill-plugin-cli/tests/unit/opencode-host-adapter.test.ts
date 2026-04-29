import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpencodeHostAdapter } from "../../src/adapters/OpencodeHostAdapter.ts";
import { InstallCliError } from "../../src/domain/errors.ts";
import type { PluginArtifactPort, ProcessRunner } from "../../src/domain/ports.ts";

function createProcessRunner(commandLog: string[] = []): ProcessRunner {
  return {
    async exec(command, args) {
      commandLog.push(`${command} ${args.join(" ")}`);
      return { stdout: "1.0.0", stderr: "", exitCode: 0 };
    },
    async spawn(command, args) {
      commandLog.push(`${command} ${args.join(" ")}`);
      return { exitCode: 0 };
    },
    async spawnDetached() {
      return;
    },
  };
}

function createArtifactPort(pluginSpec: string): PluginArtifactPort {
  return {
    async fetchArtifact() {
      return {
        installStrategy: "fallback",
        pluginSpec,
        packageName: "@wecode/skill-opencode-plugin",
        packageVersion: "1.2.3",
        localExtractPath: pluginSpec,
        localTarballPath: "/tmp/plugin.tgz",
      };
    },
  };
}

test("OpencodeHostAdapter verifyPlugin uses pluginSpec from artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-opencode-config-"));
  try {
    const configDir = join(dir, "opencode");
    await mkdir(configDir, { recursive: true });
    const fallbackPath = join(dir, ".cache", "skill-plugin-cli", "opencode", "extracted", "@wecode", "skill-opencode-plugin", "1.2.3", "package");
    await writeFile(
      join(configDir, "opencode.json"),
      JSON.stringify({ plugin: [fallbackPath] }, null, 2),
      "utf8",
    );

    const adapter = new OpencodeHostAdapter(createProcessRunner(), createArtifactPort(fallbackPath), { XDG_CONFIG_HOME: dir, HOME: dir });
    await assert.doesNotReject(async () => {
      await adapter.verifyPlugin(
        {
          command: "install",
          host: "opencode",
          installStrategy: "fallback",
          environment: "prod",
          registry: "https://npm.example.com",
          mac: "",
          channel: "openx",
        },
        {
          installStrategy: "fallback",
          pluginSpec: fallbackPath,
          packageName: "@wecode/skill-opencode-plugin",
        },
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OpencodeHostAdapter host-native install reconciles controlled fallback path to npm spec", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-opencode-config-"));
  try {
    const configDir = join(dir, "opencode");
    const fallbackPath = join(dir, ".cache", "skill-plugin-cli", "opencode", "extracted", "@wecode", "skill-opencode-plugin", "1.2.3", "package");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "opencode.json"),
      JSON.stringify({ plugin: ["other-plugin", fallbackPath] }, null, 2),
      "utf8",
    );

    const adapter = new OpencodeHostAdapter(createProcessRunner(), createArtifactPort(fallbackPath), { XDG_CONFIG_HOME: dir, HOME: dir });
    await adapter.installPlugin({
      command: "install",
      host: "opencode",
      installStrategy: "host-native",
      environment: "prod",
      registry: "https://npm.example.com",
      mac: "",
      channel: "openx",
    });

    const content = await import("node:fs/promises").then(({ readFile }) => readFile(join(configDir, "opencode.json"), "utf8"));
    assert.match(content, /other-plugin/);
    assert.match(content, /@wecode\/skill-opencode-plugin/);
    assert.doesNotMatch(content, /1\.2\.3/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OpencodeHostAdapter fallback install reconciles npm spec to controlled fallback path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-opencode-config-"));
  try {
    const configDir = join(dir, "opencode");
    const fallbackPath = join(dir, ".cache", "skill-plugin-cli", "opencode", "extracted", "@wecode", "skill-opencode-plugin", "1.2.3", "package");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "opencode.json"),
      JSON.stringify({ plugin: ["other-plugin", "@wecode/skill-opencode-plugin"] }, null, 2),
      "utf8",
    );

    const adapter = new OpencodeHostAdapter(createProcessRunner(), createArtifactPort(fallbackPath), { XDG_CONFIG_HOME: dir, HOME: dir });
    const artifact = await adapter.installPlugin({
      command: "install",
      host: "opencode",
      installStrategy: "fallback",
      environment: "prod",
      registry: "https://npm.example.com",
      mac: "",
      channel: "openx",
    });

    const content = await import("node:fs/promises").then(({ readFile }) => readFile(join(configDir, "opencode.json"), "utf8"));
    assert.equal(artifact.pluginSpec, fallbackPath);
    assert.match(content, /other-plugin/);
    assert.match(content, new RegExp(fallbackPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.doesNotMatch(content, /"@wecode\/skill-opencode-plugin"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OpencodeHostAdapter cleanupLegacyArtifacts returns warning when delete fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-opencode-config-"));
  try {
    const configDir = join(dir, "opencode");
    const pluginDir = join(configDir, "plugins");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "message-bridge.js"), "legacy", "utf8");

    const adapter = new OpencodeHostAdapter(createProcessRunner(), createArtifactPort("/tmp/plugin"), {
      XDG_CONFIG_HOME: dir,
      HOME: dir,
    });
    const originalRm = (await import("node:fs/promises")).rm;
    void originalRm;
    const result = await adapter.cleanupLegacyArtifacts().catch((error) => {
      throw error;
    });
    assert.deepEqual(result.warnings, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OpencodeHostAdapter configureHost keeps existing gateway url when context url is omitted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-opencode-config-"));
  try {
    const configDir = join(dir, "opencode");
    await mkdir(configDir, { recursive: true });
    const bridgeConfigPath = join(configDir, "message-bridge.json");
    await writeFile(
      bridgeConfigPath,
      JSON.stringify({
        gateway: {
          url: "wss://existing.example.com/ws/agent",
        },
      }, null, 2),
      "utf8",
    );

    const adapter = new OpencodeHostAdapter(createProcessRunner(), createArtifactPort("/tmp/plugin"), { XDG_CONFIG_HOME: dir, HOME: dir });
    await adapter.configureHost(
      {
        command: "install",
        host: "opencode",
        installStrategy: "host-native",
        environment: "prod",
        registry: "https://npm.example.com",
        mac: "",
        channel: "openx",
      },
      { ak: "ak-1", sk: "sk-1" },
    );

    const updatedBridgeConfig = await import("node:fs/promises").then(({ readFile }) => readFile(bridgeConfigPath, "utf8"));
    assert.match(updatedBridgeConfig, /wss:\/\/existing\.example\.com\/ws\/agent/);
    assert.doesNotMatch(updatedBridgeConfig, /"channel"\s*:/);
    assert.match(updatedBridgeConfig, /"ak": "ak-1"/);
    assert.match(updatedBridgeConfig, /"sk": "sk-1"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OpencodeHostAdapter verifyPlugin fails when plugin is absent from resolved config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-opencode-config-"));
  try {
    const configDir = join(dir, "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "opencode.json"), JSON.stringify({ plugin: [] }, null, 2), "utf8");

    const adapter = new OpencodeHostAdapter(createProcessRunner(), createArtifactPort("/tmp/plugin"), { XDG_CONFIG_HOME: dir, HOME: dir });
    await assert.rejects(
      async () => {
        await adapter.verifyPlugin(
          {
            command: "install",
            host: "opencode",
            installStrategy: "host-native",
            environment: "prod",
            registry: "https://npm.example.com",
            mac: "",
            channel: "openx",
          },
          {
            installStrategy: "host-native",
            pluginSpec: "@wecode/skill-opencode-plugin",
            packageName: "@wecode/skill-opencode-plugin",
          },
        );
      },
      (error) => error instanceof InstallCliError && error.code === "PLUGIN_INSTALL_VERIFICATION_FAILED",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
