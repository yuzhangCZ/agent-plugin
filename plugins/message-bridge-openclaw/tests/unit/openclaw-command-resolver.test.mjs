import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOpenClawInvocation,
  OPENCLAW_EXECUTION_MODE_DIRECT,
  OPENCLAW_EXECUTION_MODE_WINDOWS_CMD,
  resolveOpenClawCommandSpec,
} from "../../scripts/openclaw-command-resolver.mjs";

test("默认命令可直接执行时不依赖 which/where", () => {
  const calls = [];
  const result = resolveOpenClawCommandSpec({
    platform: "darwin",
    runSync(command, args) {
      calls.push([command, args]);
      return {
        status: 0,
        stdout: "2026.3.31",
        stderr: "",
      };
    },
  });

  assert.deepEqual(calls, [["openclaw", ["--version"]]]);
  assert.equal(result.resolvedCommand, "openclaw");
  assert.equal(result.executionMode, OPENCLAW_EXECUTION_MODE_DIRECT);
  assert.equal(result.usedPathLookup, false);
});

test("win32 下仅在首个 PATH 命中目录内优先复用 openclaw.cmd", () => {
  const calls = [];
  const result = resolveOpenClawCommandSpec({
    platform: "win32",
    runSync(command, args) {
      calls.push([command, args]);
      if (command === "openclaw") {
        return {
          error: { code: "ENOENT" },
          status: null,
          stdout: "",
          stderr: "",
        };
      }
      if (command === "where.exe") {
        return {
          status: 0,
          stdout: "D:\\devtool\\nodejs\\openclaw\r\nD:\\devtool\\nodejs\\openclaw.cmd\r\n",
          stderr: "",
        };
      }
      throw new Error(`unexpected command: ${command}`);
    },
    runShellSync(command) {
      calls.push([command, []]);
      if (command === "\"D:\\devtool\\nodejs\\openclaw.cmd\" \"--version\"") {
        return {
          status: 0,
          stdout: "2026.3.31",
          stderr: "",
        };
      }
      throw new Error(`unexpected shell command: ${command}`);
    },
  });

  assert.equal(result.resolvedCommand, "D:\\devtool\\nodejs\\openclaw.cmd");
  assert.equal(result.executionMode, OPENCLAW_EXECUTION_MODE_WINDOWS_CMD);
  assert.equal(result.usedPathLookup, true);
  assert.deepEqual(calls, [
    ["openclaw", ["--version"]],
    ["where.exe", ["openclaw"]],
    ["\"D:\\devtool\\nodejs\\openclaw.cmd\" \"--version\"", []],
  ]);
});

test("win32 下不同目录的后续 openclaw.cmd 不应覆盖 PATH 第一命中", () => {
  const calls = [];
  const result = resolveOpenClawCommandSpec({
    platform: "win32",
    runSync(command, args) {
      calls.push([command, args]);
      if (command === "openclaw") {
        return {
          error: { code: "ENOENT" },
          status: null,
          stdout: "",
          stderr: "",
        };
      }
      if (command === "where.exe") {
        return {
          status: 0,
          stdout: "C:\\first\\openclaw.exe\r\nD:\\second\\openclaw.cmd\r\n",
          stderr: "",
        };
      }
      throw new Error(`unexpected command: ${command}`);
    },
    runShellSync(command) {
      calls.push([command, []]);
      if (command === "\"C:\\first\\openclaw.exe\" \"--version\"") {
        return {
          status: 0,
          stdout: "2026.3.31",
          stderr: "",
        };
      }
      throw new Error(`unexpected shell command: ${command}`);
    },
  });

  assert.equal(result.resolvedCommand, "C:\\first\\openclaw.exe");
  assert.equal(result.executionMode, OPENCLAW_EXECUTION_MODE_DIRECT);
  assert.equal(result.usedPathLookup, true);
  assert.deepEqual(calls, [
    ["openclaw", ["--version"]],
    ["where.exe", ["openclaw"]],
    ["\"C:\\first\\openclaw.exe\" \"--version\"", []],
  ]);
});

test("where.exe 未返回 .cmd 时退回第一条候选", () => {
  const result = resolveOpenClawCommandSpec({
    platform: "win32",
    runSync(command, args) {
      if (command === "openclaw") {
        return {
          error: { code: "ENOENT" },
          status: null,
          stdout: "",
          stderr: "",
        };
      }
      if (command === "where.exe") {
        return {
          status: 0,
          stdout: "D:\\devtool\\nodejs\\openclaw\r\n",
          stderr: "",
        };
      }
      throw new Error(`unexpected command: ${command}`);
    },
    runShellSync() {
      return {
        status: 0,
        stdout: "2026.3.31",
        stderr: "",
      };
    },
  });

  assert.equal(result.resolvedCommand, "D:\\devtool\\nodejs\\openclaw");
  assert.equal(result.executionMode, OPENCLAW_EXECUTION_MODE_DIRECT);
  assert.equal(result.usedPathLookup, true);
});

test("显式 OPENCLAW_BIN 不走 which/where，但 .cmd 仍走 cmd.exe 模式", () => {
  const calls = [];
  const result = resolveOpenClawCommandSpec({
    platform: "win32",
    env: {
      OPENCLAW_BIN: "D:\\devtool\\nodejs\\openclaw.cmd",
    },
    runSync(command, args) {
      calls.push([command, args]);
      return {
        status: 0,
        stdout: "2026.3.11",
        stderr: "",
      };
    },
  });

  assert.deepEqual(calls, [[
    "cmd.exe",
    ["/d", "/s", "/c", "\"D:\\devtool\\nodejs\\openclaw.cmd\" \"--version\""],
  ]]);
  assert.equal(result.resolvedCommand, "D:\\devtool\\nodejs\\openclaw.cmd");
  assert.equal(result.executionMode, OPENCLAW_EXECUTION_MODE_WINDOWS_CMD);
  assert.equal(result.usedPathLookup, false);
});

test("which/where 未找到 openclaw 时返回 ENOENT 结果", () => {
  const calls = [];
  const result = resolveOpenClawCommandSpec({
    platform: "win32",
    runSync(command, args) {
      calls.push([command, args]);
      if (command === "openclaw") {
        return {
          error: { code: "ENOENT" },
          status: null,
          stdout: "",
          stderr: "",
        };
      }
      return {
        status: 1,
        stdout: "",
        stderr: "",
      };
    },
  });

  assert.equal(result.resolvedCommand, "openclaw");
  assert.equal(result.versionResult.error.code, "ENOENT");
  assert.equal(result.usedPathLookup, false);
  assert.deepEqual(calls, [
    ["openclaw", ["--version"]],
    ["where.exe", ["openclaw"]],
  ]);
});

test("POSIX 下 which 缺失时仍可直接执行 openclaw", () => {
  const calls = [];
  const result = resolveOpenClawCommandSpec({
    platform: "linux",
    runSync(command, args) {
      calls.push([command, args]);
      if (command === "openclaw") {
        return {
          status: 0,
          stdout: "2026.3.31",
          stderr: "",
        };
      }
      throw new Error(`unexpected command: ${command}`);
    },
  });

  assert.equal(result.resolvedCommand, "openclaw");
  assert.equal(result.executionMode, OPENCLAW_EXECUTION_MODE_DIRECT);
  assert.equal(result.usedPathLookup, false);
  assert.deepEqual(calls, [["openclaw", ["--version"]]]);
});

test("buildOpenClawInvocation 为 .cmd 生成显式 cmd.exe 调用", () => {
  const invocation = buildOpenClawInvocation({
    resolvedCommand: "D:\\devtool\\nodejs\\openclaw.cmd",
    executionMode: OPENCLAW_EXECUTION_MODE_WINDOWS_CMD,
    args: ["channels", "add", "--name", "Primary bridge"],
  });

  assert.equal(invocation.command, "cmd.exe");
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(
    invocation.args[3],
    "\"D:\\devtool\\nodejs\\openclaw.cmd\" \"channels\" \"add\" \"--name\" \"Primary bridge\"",
  );
});
