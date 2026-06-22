import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeProcessRunner } from "../../src/infrastructure/ProcessRunner.ts";
import type { ProcessCommandTrace, ProcessTraceSink } from "../../src/domain/ports.ts";

class MemoryTraceSink implements ProcessTraceSink {
  traces: ProcessCommandTrace[] = [];

  push(trace: ProcessCommandTrace) {
    this.traces.push(trace);
  }

  drain() {
    const current = this.traces;
    this.traces = [];
    return current;
  }
}

async function createScript(dir: string, name: string, body: string) {
  const filePath = join(dir, name);
  await writeFile(filePath, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(filePath, 0o755);
  return filePath;
}

test("NodeProcessRunner records exec trace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-process-runner-"));
  try {
    await createScript(dir, "hello.sh", "printf 'hello'");
    const sink = new MemoryTraceSink();
    const runner = new NodeProcessRunner(sink);

    const result = await runner.exec("sh", [join(dir, "hello.sh")]);

    assert.equal(result.stdout, "hello");
    assert.equal(result.exitCode, 0);
    assert.deepEqual(sink.drain(), [
      { phase: "started", command: "sh", args: [join(dir, "hello.sh")] },
      { phase: "finished", command: "sh", args: [join(dir, "hello.sh")], stdout: "hello", stderr: "", exitCode: 0 },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("NodeProcessRunner records spawn trace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-process-runner-"));
  try {
    await createScript(dir, "spawn.sh", "printf 'spawned'");
    const sink = new MemoryTraceSink();
    const runner = new NodeProcessRunner(sink);

    const result = await runner.spawn("sh", [join(dir, "spawn.sh")]);

    assert.equal(result.stdout, "spawned");
    assert.equal(result.exitCode, 0);
    assert.deepEqual(sink.drain(), [
      { phase: "started", command: "sh", args: [join(dir, "spawn.sh")] },
      { phase: "finished", command: "sh", args: [join(dir, "spawn.sh")], stdout: "spawned", stderr: "", exitCode: 0 },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("NodeProcessRunner returns non-zero exit code and records stderr trace", async () => {
  const sink = new MemoryTraceSink();
  const runner = new NodeProcessRunner(sink);

  const result = await runner.exec("sh", ["-c", "printf 'failed' >&2; exit 7"]);

  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "failed");
  assert.equal(result.exitCode, 7);
  assert.deepEqual(sink.drain(), [
    { phase: "started", command: "sh", args: ["-c", "printf 'failed' >&2; exit 7"] },
    { phase: "finished", command: "sh", args: ["-c", "printf 'failed' >&2; exit 7"], stdout: "", stderr: "failed", exitCode: 7 },
  ]);
});

test("NodeProcessRunner preserves trailing newlines in captured output", async () => {
  const sink = new MemoryTraceSink();
  const runner = new NodeProcessRunner(sink);

  const result = await runner.exec("sh", ["-c", "printf 'line\\n'; printf 'error\\n' >&2"]);

  assert.equal(result.stdout, "line\n");
  assert.equal(result.stderr, "error\n");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(sink.drain(), [
    { phase: "started", command: "sh", args: ["-c", "printf 'line\\n'; printf 'error\\n' >&2"] },
    { phase: "finished", command: "sh", args: ["-c", "printf 'line\\n'; printf 'error\\n' >&2"], stdout: "line\n", stderr: "error\n", exitCode: 0 },
  ]);
});

test("NodeProcessRunner records failed start trace before rejecting", async () => {
  const sink = new MemoryTraceSink();
  const runner = new NodeProcessRunner(sink);
  const missingCwd = join(tmpdir(), "skill-plugin-cli-missing-cwd");

  await assert.rejects(
    async () => {
      await runner.exec(process.execPath, ["--version"], { cwd: missingCwd });
    },
    /ENOENT/u,
  );

  const traces = sink.drain();
  assert.equal(traces[0]?.phase, "started");
  assert.equal(traces[0]?.command, process.execPath);
  assert.equal(traces[1]?.phase, "finished");
  assert.equal(traces[1]?.command, process.execPath);
  assert.equal(traces[1]?.exitCode, 1);
  assert.match(traces[1]?.stderr ?? "", /ENOENT/u);
});

test("NodeProcessRunner does not forge detached completion trace", async () => {
  const sink = new MemoryTraceSink();
  const runner = new NodeProcessRunner(sink);

  await runner.spawnDetached("sh", ["-c", "exit 0"]);

  assert.deepEqual(sink.drain(), [
    { phase: "started", command: "sh", args: ["-c", "exit 0"] },
  ]);
});
