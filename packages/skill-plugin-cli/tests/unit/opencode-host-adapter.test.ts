import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpencodeHostAdapter } from "../../src/adapters/OpencodeHostAdapter.ts";
import { InstallCliError } from "../../src/domain/errors.ts";
import type { PluginArtifactPort, ProcessRunner } from "../../src/domain/ports.ts";

const noopArtifactPort: PluginArtifactPort = {
  async fetchArtifact() {
    return {
      installStrategy: "fallback",
      pluginSpec: "/tmp/plugin/package",
      packageName: "@wecode/skill-opencode-plugin",
      packageVersion: "1.2.3",
      localExtractPath: "/tmp/plugin/package",
      localTarballPath: "/tmp/plugin.tgz",
    };
  },
};

const noopProcessRunner: ProcessRunner = {
  async exec() {
    return { stdout: "", stderr: "", exitCode: 0 };
  },
  async spawn() {
    return { stdout: "", stderr: "", exitCode: 0 };
  },
  async spawnDetached() {
    return;
  },
};

test("OpencodeHostAdapter verifyPlugin uses existing json config and passes when plugin is present", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-opencode-config-"));
  try {
    const configDir = join(dir, "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "opencode.json"), JSON.stringify({ plugin: ["@wecode/skill-opencode-plugin"] }, null, 2), "utf8");

    const adapter = new OpencodeHostAdapter(noopProcessRunner, noopArtifactPort, { XDG_CONFIG_HOME: dir });
    await assert.doesNotReject(async () => {
      await adapter.verifyPlugin({} as never, {
        installStrategy: "host-native",
        pluginSpec: "@wecode/skill-opencode-plugin",
        packageName: "@wecode/skill-opencode-plugin",
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OpencodeHostAdapter preflight returns resolved primary config path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-opencode-preflight-"));
  try {
    const configDir = join(dir, "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "opencode.json"), JSON.stringify({ plugin: [] }, null, 2), "utf8");

    const adapter = new OpencodeHostAdapter(noopProcessRunner, noopArtifactPort, { XDG_CONFIG_HOME: dir });
    const result = await adapter.preflight();

    assert.equal(result.metadata.hostDisplayName, "opencode");
    assert.equal(result.metadata.primaryConfigPath, join(configDir, "opencode.json"));
    assert.equal(result.existingPluginDetected, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OpencodeHostAdapter preflight detects existing managed plugin reference", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-opencode-preflight-existing-"));
  try {
    const configDir = join(dir, "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "opencode.json"), JSON.stringify({ plugin: ["@wecode/skill-opencode-plugin"] }, null, 2), "utf8");

    const adapter = new OpencodeHostAdapter(noopProcessRunner, noopArtifactPort, { XDG_CONFIG_HOME: dir });
    const result = await adapter.preflight();

    assert.equal(result.existingPluginDetected, true);
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

    const adapter = new OpencodeHostAdapter(noopProcessRunner, noopArtifactPort, { XDG_CONFIG_HOME: dir });
    await assert.rejects(
      async () => {
        await adapter.verifyPlugin({} as never, {
          installStrategy: "host-native",
          pluginSpec: "@wecode/skill-opencode-plugin",
          packageName: "@wecode/skill-opencode-plugin",
        });
      },
      (error) => error instanceof InstallCliError && error.code === "PLUGIN_INSTALL_VERIFICATION_FAILED",
    );
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
    await writeFile(join(configDir, "opencode.json"), JSON.stringify({ plugin: ["@wecode/skill-opencode-plugin"] }, null, 2), "utf8");

    const adapter = new OpencodeHostAdapter(noopProcessRunner, noopArtifactPort, { XDG_CONFIG_HOME: dir });
    const result = await adapter.configureHost(
      {
        command: "install",
        host: "opencode",
        installStrategy: "host-native",
        environment: "prod",
        registry: "https://npm.example.com",
        mac: "",
        channel: "opencode",
        verbose: false,
      },
      { ak: "ak-1", sk: "sk-1" },
    );

    assert.deepEqual(result, {
      primaryConfigPath: join(configDir, "opencode.json"),
      additionalConfigPaths: [bridgeConfigPath],
    });
    const updatedBridgeConfig = await readFile(bridgeConfigPath, "utf8");
    assert.match(updatedBridgeConfig, /wss:\/\/existing\.example\.com\/ws\/agent/);
    assert.doesNotMatch(updatedBridgeConfig, /"channel"\s*:/);
    assert.match(updatedBridgeConfig, /"ak": "ak-1"/);
    assert.match(updatedBridgeConfig, /"sk": "sk-1"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OpencodeHostAdapter fallback install reconciles plugin spec to local path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-opencode-fallback-"));
  try {
    const configDir = join(dir, "opencode");
    await mkdir(configDir, { recursive: true });
    const opencodeConfigPath = join(configDir, "opencode.json");
    await writeFile(opencodeConfigPath, JSON.stringify({ plugin: [] }, null, 2), "utf8");

    const adapter = new OpencodeHostAdapter(noopProcessRunner, noopArtifactPort, {
      XDG_CONFIG_HOME: dir,
      XDG_CACHE_HOME: join(dir, ".cache"),
      HOME: dir,
    });
    const artifact = await adapter.installPlugin({
      command: "install",
      host: "opencode",
      installStrategy: "fallback",
      environment: "prod",
      registry: "https://npm.example.com",
      mac: "",
      channel: "opencode",
      verbose: false,
    });

    assert.equal(artifact.pluginSpec, "/tmp/plugin/package");
    const nextConfig = await readFile(opencodeConfigPath, "utf8");
    assert.match(nextConfig, /\/tmp\/plugin\/package/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
