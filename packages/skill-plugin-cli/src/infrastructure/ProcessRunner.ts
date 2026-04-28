import { spawn } from "node:child_process";
import { InstallCliError } from "../domain/errors.ts";
import type { ProcessRunner } from "../domain/ports.ts";

export class NodeProcessRunner implements ProcessRunner {
  async exec(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
    return await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
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
        resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
      });
    });
  }

  async spawn(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: "inherit" | "pipe" } = {}) {
    return await new Promise<{ exitCode: number }>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env ?? {}) },
        stdio: options.stdio ?? "inherit",
        shell: false,
      });

      child.on("error", (error: Error) => reject(new InstallCliError("PROCESS_SPAWN_FAILED", error.message)));
      child.on("exit", (exitCode: number | null) => {
        resolve({ exitCode: exitCode ?? 1 });
      });
    });
  }

  async spawnDetached(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
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
