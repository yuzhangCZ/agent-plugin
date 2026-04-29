#!/usr/bin/env node
import process from "node:process";
import { parseInstallArgv, formatHelp } from "./parse-argv.ts";
import { createInstallCliUseCase } from "./runtime.ts";
import { InstallCliError } from "../domain/errors.ts";

async function main() {
  try {
    const parsed = parseInstallArgv(process.argv.slice(2));
    if ("help" in parsed) {
      process.stdout.write(`${formatHelp()}\n`);
      return;
    }
    const useCase = createInstallCliUseCase();
    const result = await useCase.execute(parsed);
    process.exitCode = result.status === "success" ? 0 : 1;
  } catch (error) {
    const installError = error instanceof InstallCliError
      ? error
      : new InstallCliError("INSTALLER_FAILED", error instanceof Error ? error.message : String(error));
    if (installError.code === "INSTALLER_USAGE_ERROR") {
      process.stderr.write(`[skill-plugin-cli] 参数错误：${installError.message}\n`);
      process.stderr.write("[skill-plugin-cli] 可执行 skill-plugin-cli --help 查看用法\n");
    } else {
      process.stderr.write(`[skill-plugin-cli] 接入失败：${installError.message}\n`);
    }
    process.exitCode = 1;
  }
}

await main();
