import assert from "node:assert/strict";
import test from "node:test";
import { parseInstallArgv } from "../../src/cli/parse-argv.ts";
import { InstallCliError } from "../../src/domain/errors.ts";

test("parseInstallArgv parses shared install contract", () => {
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
  ]);

  assert.deepEqual(parsed, {
    command: "install",
    host: "openclaw",
    environment: "uat",
    registry: "https://npm.example.com",
    url: "wss://gateway.example.com/ws/agent",
  });
});

test("parseInstallArgv rejects missing or invalid host and environment", () => {
  assert.throws(
    () => parseInstallArgv(["install", "--environment", "uat"]),
    (error) => error instanceof InstallCliError && error.code === "INSTALLER_USAGE_ERROR",
  );
  assert.throws(
    () => parseInstallArgv(["install", "--host", "opencode", "--environment", "staging"]),
    (error) => error instanceof InstallCliError && error.code === "INSTALLER_USAGE_ERROR",
  );
});
