import { parseArgs } from "node:util";
import { InstallCliError } from "../domain/errors.ts";
import type { ParsedInstallCommand } from "../domain/types.ts";

const HELP_TEXT = `skill-plugin-cli

用于安装插件、创建 WeLink 助理，并完成与 gateway 的连接配置。

用法:
  skill-plugin-cli install --host opencode [--environment uat|prod] [--registry <url>] [--url <gateway-url>] [--verbose]
    [--install-strategy host-native|fallback]
  skill-plugin-cli install --host openclaw [--environment uat|prod] [--registry <url>] [--url <gateway-url>] [--verbose]
    [--install-strategy host-native|fallback]

示例:
  skill-plugin-cli install --host opencode
  skill-plugin-cli install --host openclaw --environment uat
  skill-plugin-cli install --host openclaw --url ws://localhost:8081/ws/agent
  skill-plugin-cli install --host opencode --verbose
  skill-plugin-cli install --host openclaw --install-strategy fallback

参数:
  --host <opencode|openclaw>                 指定接入目标
  --environment <uat|prod>                   指定 WeLink 创建助理环境，默认 prod
  --registry <url>                           指定 @wecode npm 仓源
  --url <gateway-url>                        指定插件连接 gateway 的地址
  --verbose                                  显示详细执行过程
  --install-strategy <host-native|fallback>  指定插件安装策略，默认 host-native
  -h, --help                                 查看帮助
`;

function assertEnvironment(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  if (value !== "uat" && value !== "prod") {
    throw new InstallCliError("INSTALLER_USAGE_ERROR", "--environment 仅支持 uat 或 prod，默认值为 prod");
  }
  return value;
}

function assertHost(value: string | undefined) {
  if (value !== "opencode" && value !== "openclaw") {
    throw new InstallCliError("INSTALLER_USAGE_ERROR", "--host 必须为 opencode 或 openclaw");
  }
  return value;
}

function assertInstallStrategy(value: string | undefined) {
  if (!value) {
    return "host-native" as const;
  }
  if (value !== "host-native" && value !== "fallback") {
    throw new InstallCliError("INSTALLER_USAGE_ERROR", "--install-strategy 仅支持 host-native 或 fallback");
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
      "install-strategy": { type: "string" },
      environment: { type: "string" },
      registry: { type: "string" },
      url: { type: "string" },
      verbose: { type: "boolean" },
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
    installStrategy: assertInstallStrategy(values["install-strategy"]),
    environment: assertEnvironment(values.environment),
    registry: values.registry?.trim() || undefined,
    url: values.url?.trim() || undefined,
    verbose: values.verbose ?? false,
  };
}
