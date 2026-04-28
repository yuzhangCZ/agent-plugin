#!/usr/bin/env node

import process from "node:process";

const HELP_TEXT = `Message Bridge compatibility wrapper

正式入口:
  skill-plugin-cli install --host opencode [--environment uat|prod] [--registry <url>] [--url <gateway-url>]

兼容入口:
  node ./scripts/setup-message-bridge.mjs [install] [--environment <env>] [--registry <url>] [--url <gateway-url>] [--yes] [--scope <value>]
`;

function writeLine(message) {
  process.stdout.write(`${message}\n`);
}

function writeError(message) {
  process.stderr.write(`${message}\n`);
}

async function loadSkillPluginCliModule() {
  const attempts = [
    () => import(new URL("../../../packages/skill-plugin-cli/src/index.ts", import.meta.url).href),
    () => import("@wecode/skill-plugin-cli"),
  ];

  const failures = [];
  for (const load of attempts) {
    try {
      return await load();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(`无法加载 @wecode/skill-plugin-cli：${failures.join(" | ")}`);
}

function readOptionValue(args, option, currentIndex) {
  const value = args[currentIndex + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${option} 需要一个值`);
  }
  return value;
}

function parseCompatibilityArgs(rawArgs) {
  const mapped = ["install", "--host", "opencode"];
  const warnings = [];
  const args = [...rawArgs];

  if (args[0] === "install") {
    args.shift();
  }

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    switch (token) {
      case "--help":
      case "-h":
        return { help: true, mapped: [], warnings: [] };
      case "--environment":
      case "--registry":
      case "--url": {
        const value = readOptionValue(args, token, index);
        mapped.push(token, value);
        index += 1;
        break;
      }
      case "--yes":
        warnings.push("兼容参数 --yes 已废弃，当前版本会忽略。");
        break;
      case "--scope": {
        const value = readOptionValue(args, token, index);
        warnings.push(`兼容参数 --scope=${value} 已废弃，当前始终执行全局安装与全局配置。`);
        index += 1;
        break;
      }
      default:
        throw new Error(`不支持的兼容参数: ${token}`);
    }
  }

  return { help: false, mapped, warnings };
}

async function main() {
  const parsed = parseCompatibilityArgs(process.argv.slice(2));
  if (parsed.help) {
    writeLine(HELP_TEXT);
    return;
  }

  for (const warning of parsed.warnings) {
    writeLine(`[setup-message-bridge][warning] ${warning}`);
  }

  const cliModule = await loadSkillPluginCliModule();
  const command = cliModule.parseInstallArgv(parsed.mapped);
  if ("help" in command) {
    writeLine(HELP_TEXT);
    return;
  }

  const useCase = cliModule.createInstallCliUseCase();
  const result = await useCase.execute(command);
  process.exitCode = result.status === "success" ? 0 : 1;
}

main().catch((error) => {
  writeError(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
