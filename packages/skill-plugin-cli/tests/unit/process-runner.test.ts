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

test("NodeProcessRunner does not forge detached completion trace", async () => {
  const sink = new MemoryTraceSink();
  const runner = new NodeProcessRunner(sink);

  await runner.spawnDetached("sh", ["-c", "exit 0"]);

  assert.deepEqual(sink.drain(), [
    { phase: "started", command: "sh", args: ["-c", "exit 0"] },
  ]);
});
