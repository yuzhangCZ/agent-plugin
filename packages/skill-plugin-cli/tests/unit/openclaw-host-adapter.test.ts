import assert from "node:assert/strict";
import test from "node:test";
import { OpenClawHostAdapter } from "../../src/adapters/OpenClawHostAdapter.ts";
import { InstallCliError } from "../../src/domain/errors.ts";
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
      return { exitCode: 0 };
    },
    async spawnDetached() {
      return;
    },
  };
}

test("OpenClawHostAdapter preflight accepts versions newer than the minimum runtime", async () => {
  const adapter = new OpenClawHostAdapter(createProcessRunner("2026.4.12"));

  const result = await adapter.preflight();

  assert.match(result.detail, /2026\.4\.12/);
});

test("OpenClawHostAdapter preflight rejects versions older than the minimum runtime", async () => {
  const adapter = new OpenClawHostAdapter(createProcessRunner("2026.3.23"));

  await assert.rejects(
    async () => {
      await adapter.preflight();
    },
    (error) => error instanceof InstallCliError && error.code === "OPENCLAW_VERSION_UNSUPPORTED",
  );
});

test("OpenClawHostAdapter confirmAvailability returns manual gateway restart next steps after probe", async () => {
  const adapter = new OpenClawHostAdapter(createProcessRunner("2026.4.12"));

  const result = await adapter.confirmAvailability();

  assert.equal(result.detail, "探活通过，channel 已可用。");
  assert.deepEqual(result.nextSteps, [
    "下一步：请手动重启 OpenClaw gateway 以确认 channel 生效。",
    "可执行命令：openclaw gateway restart",
  ]);
});
