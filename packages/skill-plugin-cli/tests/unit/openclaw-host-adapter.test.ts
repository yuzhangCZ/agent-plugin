import assert from "node:assert/strict";
import test from "node:test";
import { OpenClawHostAdapter } from "../../src/adapters/OpenClawHostAdapter.ts";
import type { ProcessRunner } from "../../src/domain/ports.ts";

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
        exitCode: 0,
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

test("OpenClawHostAdapter preflight accepts versions newer than the minimum runtime", async () => {
  const adapter = new OpenClawHostAdapter(createProcessRunner("2026.4.12"));

  const result = await adapter.preflight();

  assert.equal(result.version, "2026.4.12");
  assert.equal(result.versionSupported, true);
  assert.equal(result.metadata.hostDisplayName, "openclaw");
  assert.match(result.metadata.primaryConfigPath, /openclaw\.json$/);
});

test("OpenClawHostAdapter preflight rejects versions older than the minimum runtime", async () => {
  const adapter = new OpenClawHostAdapter(createProcessRunner("2026.3.23"));

  const result = await adapter.preflight();

  assert.equal(result.version, "2026.3.23");
  assert.equal(result.versionSupported, false);
  assert.equal(result.minimumRequiredVersion, "2026.3.24");
});

test("OpenClawHostAdapter confirmAvailability returns manual gateway restart next steps after probe", async () => {
  const adapter = new OpenClawHostAdapter(createProcessRunner("2026.4.12"));

  const result = await adapter.confirmAvailability();

  assert.deepEqual(result, {
    nextAction: {
      kind: "restart_gateway",
      manual: true,
      effect: "gateway_config_effective",
      command: "openclaw gateway restart",
    },
  });
});
