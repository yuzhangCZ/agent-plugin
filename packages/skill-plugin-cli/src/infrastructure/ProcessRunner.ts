import { spawn } from "node:child_process";
import process from "node:process";
import { InstallCliError } from "../domain/errors.ts";
import type { ProcessRunner, ProcessTraceSink } from "../domain/ports.ts";

const SHOULD_USE_SHELL = process.platform === "win32";

export class NodeProcessRunner implements ProcessRunner {
  private readonly traceSink?: ProcessTraceSink;

  constructor(traceSink?: ProcessTraceSink) {
    this.traceSink = traceSink;
  }

  async exec(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.traceSink?.push({ phase: "started", command, args });
    return await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
        shell: SHOULD_USE_SHELL,
      });

      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error: Error) => reject(new InstallCliError("PROCESS_EXEC_FAILED", error.message)));
      child.on("exit", (exitCode: number | null) => {
        const result = { stdout, stderr, exitCode: exitCode ?? 1 };
        this.traceSink?.push({ phase: "finished", command, args, ...result });
        resolve(result);
      });
    });
  }

  async spawn(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.traceSink?.push({ phase: "started", command, args });
    return await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
        shell: SHOULD_USE_SHELL,
      });

      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error: Error) => reject(new InstallCliError("PROCESS_SPAWN_FAILED", error.message)));
      child.on("exit", (exitCode: number | null) => {
        const result = { stdout, stderr, exitCode: exitCode ?? 1 };
        this.traceSink?.push({ phase: "finished", command, args, ...result });
        resolve(result);
      });
    });
  }

  async spawnDetached(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.traceSink?.push({ phase: "started", command, args });
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child.on("error", () => undefined);
    child.unref();
  }
}
