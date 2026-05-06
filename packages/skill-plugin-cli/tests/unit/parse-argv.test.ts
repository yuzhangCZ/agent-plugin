import assert from "node:assert/strict";
import test from "node:test";
import { parseInstallArgv } from "../../src/cli/parse-argv.ts";
import { InstallCliError } from "../../src/domain/errors.ts";

test("parseInstallArgv defaults installStrategy to host-native", () => {
  const parsed = parseInstallArgv(["install", "--host", "openclaw"]);
  assert.deepEqual(parsed, {
    command: "install",
    host: "openclaw",
    installStrategy: "host-native",
    environment: undefined,
    registry: undefined,
    url: undefined,
  });
});

test("parseInstallArgv parses explicit fallback installStrategy", () => {
  const parsed = parseInstallArgv([
    "install",
    "--host",
    "openclaw",
    "--install-strategy",
    "fallback",
    "--environment",
    "uat",
    "--registry",
    "https://npm.example.com",
    "--url",
    "wss://gateway.example.com/ws/agent",
  ]);

  assert.deepEqual(parsed, {
    command: "install",
    host: "openclaw",
    installStrategy: "fallback",
    environment: "uat",
    registry: "https://npm.example.com",
    url: "wss://gateway.example.com/ws/agent",
  });
});

test("parseInstallArgv rejects invalid host environment or installStrategy", () => {
  assert.throws(
    () => parseInstallArgv(["install", "--environment", "uat"]),
    (error) => error instanceof InstallCliError && error.code === "INSTALLER_USAGE_ERROR",
  );
  assert.throws(
    () => parseInstallArgv(["install", "--host", "opencode", "--environment", "staging"]),
    (error) => error instanceof InstallCliError && error.code === "INSTALLER_USAGE_ERROR",
  );
  assert.throws(
    () => parseInstallArgv(["install", "--host", "opencode", "--install-strategy", "auto"]),
    (error) => error instanceof InstallCliError && error.code === "INSTALLER_USAGE_ERROR",
  );
});
