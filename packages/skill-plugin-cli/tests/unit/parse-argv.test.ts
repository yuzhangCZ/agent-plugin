import assert from "node:assert/strict";
import test from "node:test";
import { formatHelp, parseInstallArgv } from "../../src/cli/parse-argv.ts";
import { InstallCliError } from "../../src/domain/errors.ts";

test("parseInstallArgv parses install contract with verbose", () => {
  const parsed = parseInstallArgv([
    "install",
    "--host",
    "openclaw",
    "--environment",
    "uat",
    "--registry",
    "https://npm.example.com",
    "--url",
    "wss://gateway.example.com/ws/agent",
    "--verbose",
  ]);

  assert.deepEqual(parsed, {
    command: "install",
    host: "openclaw",
    environment: "uat",
    registry: "https://npm.example.com",
    url: "wss://gateway.example.com/ws/agent",
    verbose: true,
  });
});

test("formatHelp matches output spec", () => {
  assert.equal(
    formatHelp(),
    "skill-plugin-cli\n"
      + "\n"
      + "用于安装插件、创建 WeLink 助理，并完成与 gateway 的连接配置。\n"
      + "\n"
      + "用法:\n"
      + "  skill-plugin-cli install --host opencode [--environment uat|prod] [--registry <url>] [--url <gateway-url>] [--verbose]\n"
      + "  skill-plugin-cli install --host openclaw [--environment uat|prod] [--registry <url>] [--url <gateway-url>] [--verbose]\n"
      + "\n"
      + "示例:\n"
      + "  skill-plugin-cli install --host opencode\n"
      + "  skill-plugin-cli install --host openclaw --environment uat\n"
      + "  skill-plugin-cli install --host openclaw --url ws://localhost:8081/ws/agent\n"
      + "  skill-plugin-cli install --host opencode --verbose\n"
      + "\n"
      + "参数:\n"
      + "  --host <opencode|openclaw>   指定接入目标\n"
      + "  --environment <uat|prod>     指定 WeLink 创建助理环境，默认 prod\n"
      + "  --registry <url>             指定 @wecode npm 仓源\n"
      + "  --url <gateway-url>          指定插件连接 gateway 的地址\n"
      + "  --verbose                    显示详细执行过程\n"
      + "  -h, --help                   查看帮助\n",
  );
});

test("parseInstallArgv rejects invalid host and environment with usage errors", () => {
  assert.throws(
    () => parseInstallArgv(["install", "--environment", "uat"]),
    (error) => error instanceof InstallCliError && error.code === "INSTALLER_USAGE_ERROR",
  );
  assert.throws(
    () => parseInstallArgv(["install", "--host", "opencode", "--environment", "staging"]),
    (error) => error instanceof InstallCliError
      && error.code === "INSTALLER_USAGE_ERROR"
      && error.message === "--environment 仅支持 uat 或 prod，默认值为 prod",
  );
});
