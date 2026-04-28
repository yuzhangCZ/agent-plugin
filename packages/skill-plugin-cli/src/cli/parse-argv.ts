import { parseArgs } from "node:util";
import { InstallCliError } from "../domain/errors.ts";
import type { ParsedInstallCommand } from "../domain/types.ts";

const HELP_TEXT = `skill-plugin-cli

用法:
  skill-plugin-cli install --host opencode [--environment uat|prod] [--registry <url>] [--url <gateway-url>]
  skill-plugin-cli install --host openclaw [--environment uat|prod] [--registry <url>] [--url <gateway-url>]
`;

function assertEnvironment(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  if (value !== "uat" && value !== "prod") {
    throw new InstallCliError("INSTALLER_USAGE_ERROR", "--environment 仅支持 uat 或 prod");
  }
  return value;
}

function assertHost(value: string | undefined) {
  if (value !== "opencode" && value !== "openclaw") {
    throw new InstallCliError("INSTALLER_USAGE_ERROR", "--host 必须为 opencode 或 openclaw");
  }
  return value;
}

export function formatHelp() {
  return HELP_TEXT;
}

export function parseInstallArgv(argv: string[]): ParsedInstallCommand | { help: true } {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    return { help: true };
  }
  if (command !== "install") {
    throw new InstallCliError("INSTALLER_USAGE_ERROR", `不支持的子命令: ${command}`);
  }

  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      host: { type: "string" },
      environment: { type: "string" },
      registry: { type: "string" },
      url: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    return { help: true };
  }
  if (positionals.length > 0) {
    throw new InstallCliError("INSTALLER_USAGE_ERROR", `不支持的参数: ${positionals[0]}`);
  }

  return {
    command: "install",
    host: assertHost(values.host),
    environment: assertEnvironment(values.environment),
    registry: values.registry?.trim() || undefined,
    url: values.url?.trim() || undefined,
  };
}
