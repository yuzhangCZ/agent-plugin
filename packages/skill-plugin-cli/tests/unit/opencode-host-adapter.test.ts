import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpencodeHostAdapter } from "../../src/adapters/OpencodeHostAdapter.ts";
import { InstallCliError } from "../../src/domain/errors.ts";
import type { ProcessRunner } from "../../src/domain/ports.ts";

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
    await writeFile(
      join(configDir, "opencode.json"),
      JSON.stringify({ plugin: ["@wecode/skill-opencode-plugin"] }, null, 2),
      "utf8",
    );

    const adapter = new OpencodeHostAdapter(noopProcessRunner, { XDG_CONFIG_HOME: dir });
    await assert.doesNotReject(async () => {
      await adapter.verifyPlugin();
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

    const adapter = new OpencodeHostAdapter(noopProcessRunner, { XDG_CONFIG_HOME: dir });
    const result = await adapter.preflight();

    assert.equal(result.metadata.hostDisplayName, "opencode");
    assert.equal(result.metadata.primaryConfigPath, join(configDir, "opencode.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OpencodeHostAdapter verifyPlugin fails when plugin is absent from resolved config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-opencode-config-"));
  try {
    const configDir = join(dir, "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "opencode.json"),
      JSON.stringify({ plugin: [] }, null, 2),
      "utf8",
    );

    const adapter = new OpencodeHostAdapter(noopProcessRunner, { XDG_CONFIG_HOME: dir });
    await assert.rejects(
      async () => {
        await adapter.verifyPlugin();
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
    await writeFile(
      join(configDir, "opencode.json"),
      JSON.stringify({ plugin: ["@wecode/skill-opencode-plugin"] }, null, 2),
      "utf8",
    );

    const adapter = new OpencodeHostAdapter(noopProcessRunner, { XDG_CONFIG_HOME: dir });
    await adapter.configureHost(
      {
        command: "install",
        host: "opencode",
        environment: "prod",
        registry: "https://npm.example.com",
        mac: "",
        channel: "openx",
        verbose: false,
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

test("OpencodeHostAdapter configureHost writes gateway url without channel when context url is provided", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-opencode-config-"));
  try {
    const configDir = join(dir, "opencode");
    await mkdir(configDir, { recursive: true });
    const bridgeConfigPath = join(configDir, "message-bridge.json");
    await writeFile(
      join(configDir, "opencode.json"),
      JSON.stringify({ plugin: ["@wecode/skill-opencode-plugin"] }, null, 2),
      "utf8",
    );

    const adapter = new OpencodeHostAdapter(noopProcessRunner, { XDG_CONFIG_HOME: dir });
    await adapter.configureHost(
      {
        command: "install",
        host: "opencode",
        environment: "prod",
        registry: "https://npm.example.com",
        url: "wss://gateway.example.com/ws/agent",
        mac: "",
        channel: "openx",
        verbose: false,
      },
      { ak: "ak-2", sk: "sk-2" },
    );

    const updatedBridgeConfig = await import("node:fs/promises").then(({ readFile }) => readFile(bridgeConfigPath, "utf8"));
    assert.match(updatedBridgeConfig, /"url": "wss:\/\/gateway\.example\.com\/ws\/agent"/);
    assert.doesNotMatch(updatedBridgeConfig, /"channel"\s*:/);
    assert.match(updatedBridgeConfig, /"ak": "ak-2"/);
    assert.match(updatedBridgeConfig, /"sk": "sk-2"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OpencodeHostAdapter confirmAvailability returns manual restart next steps", async () => {
  const adapter = new OpencodeHostAdapter(noopProcessRunner, {});

  const result = await adapter.confirmAvailability({
    command: "install",
    host: "opencode",
      environment: "prod",
      registry: "https://npm.example.com",
      mac: "",
      channel: "openx",
      verbose: false,
    });

  assert.deepEqual(result, {
    nextAction: {
      kind: "restart_host",
      manual: true,
      effect: "plugin_and_config_effective",
    },
  });
});
