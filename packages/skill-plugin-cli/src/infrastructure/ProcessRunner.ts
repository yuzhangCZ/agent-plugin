import { spawn } from "node:child_process";
import process from "node:process";
import { execa } from "execa";
import { InstallCliError } from "../domain/errors.ts";
import type { ProcessRunner, ProcessTraceSink } from "../domain/ports.ts";

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ExecaRunResult {
  failed: boolean;
  exitCode?: number;
  message?: string;
  shortMessage?: string;
  stderr: string;
  stdout: string;
}

function isStartFailure(result: ExecaRunResult): boolean {
  return result.failed && typeof result.exitCode !== "number";
}

function buildStartFailure(input: {
  args: string[];
  command: string;
  result: ExecaRunResult;
}): { message: string; output: RunResult } {
  const message = input.result.shortMessage || input.result.message || `${input.command} ${input.args.join(" ")} failed to start`;
  return {
    message,
    output: {
      stdout: input.result.stdout,
      stderr: input.result.stderr || message,
      exitCode: 1,
    },
  };
}

function toRunResult(result: ExecaRunResult): RunResult {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 1,
  };
}

function toErrorResult(error: unknown): { message: string; output: RunResult } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    message,
    output: {
      stdout: "",
      stderr: message,
      exitCode: 1,
    },
  };
}

export class NodeProcessRunner implements ProcessRunner {
  private readonly traceSink?: ProcessTraceSink;

  constructor(traceSink?: ProcessTraceSink) {
    this.traceSink = traceSink;
  }

  private async run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }, errorCode: string): Promise<RunResult> {
    this.traceSink?.push({ phase: "started", command, args });
    try {
      const result = await execa(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env ?? {}) },
        reject: false,
        stripFinalNewline: false,
        windowsHide: true,
      });
      if (isStartFailure(result)) {
        const { message, output } = buildStartFailure({ args, command, result });
        this.traceSink?.push({ phase: "finished", command, args, ...output });
        throw new InstallCliError(errorCode, message);
      }
      const output = toRunResult(result);
      this.traceSink?.push({ phase: "finished", command, args, ...output });
      return output;
    } catch (error) {
      if (error instanceof InstallCliError) {
        throw error;
      }
      const { message, output } = toErrorResult(error);
      this.traceSink?.push({ phase: "finished", command, args, ...output });
      throw new InstallCliError(errorCode, message);
    }
  }

  async exec(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
    return await this.run(command, args, options, "PROCESS_EXEC_FAILED");
  }

  async spawn(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
    return await this.run(command, args, options, "PROCESS_SPAWN_FAILED");
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
