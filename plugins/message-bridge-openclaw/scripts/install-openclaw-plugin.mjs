#!/usr/bin/env node

import process from "node:process";

const HELP_TEXT = `OpenClaw compatibility wrapper

正式入口:
  skill-plugin-cli install --host openclaw [--environment uat|prod] [--registry <url>] [--url <gateway-url>]

兼容入口:
  node ./scripts/install-openclaw-plugin.mjs [--environment <env>] [--registry <url>] [--url <gateway-url>]
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
  const mapped = ["install", "--host", "openclaw"];
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
      case "--dev":
      case "--openclaw-bin":
      case "--no-restart":
        throw new Error(`兼容参数 ${token} 已废弃且会改变统一安装完成语义，当前版本不再支持。`);
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
    writeLine(`[install-openclaw-plugin][warning] ${warning}`);
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
