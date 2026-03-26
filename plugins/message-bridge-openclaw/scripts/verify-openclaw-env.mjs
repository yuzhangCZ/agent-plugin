#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { createFailure, ensureCommand, findAvailablePort, readCommandVersion, resolveOpenClawCommand, ROOT_DIR, assertVersionSatisfies } from "./openclaw-test-shared.mjs";

const runId = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const logDir = path.join(ROOT_DIR, "logs");
const summaryPath = path.join(logDir, `verify-openclaw-env-${runId}.json`);
const gatewayPort = Number(process.env.MB_RUNTIME_GATEWAY_PORT ?? "18081");
const openclawPort = Number(process.env.MB_RUNTIME_OPENCLAW_PORT ?? "19101");

async function main() {
  await mkdir(logDir, { recursive: true });

  const summary = {
    generatedAt: new Date().toISOString(),
    failure_category: "NONE",
    failure_code: "NONE",
    checks: {
      commands: [],
      openclaw: {},
      ports: {},
    },
  };

  try {
    ensureCommand("node");
    summary.checks.commands.push({ command: "node", status: "ok" });

    const openclawCmd = resolveOpenClawCommand();
    summary.checks.commands.push({ command: openclawCmd, status: "ok" });

    const packageJson = JSON.parse(await readFile(path.join(ROOT_DIR, "package.json"), "utf8"));
    const requiredRange = packageJson.peerDependencies?.openclaw ?? ">=0.0.0";
    const currentVersion = readCommandVersion(openclawCmd);
    assertVersionSatisfies(currentVersion, requiredRange);
    summary.checks.openclaw = {
      command: openclawCmd,
      version: currentVersion,
      requiredRange,
      status: "ok",
    };

    summary.checks.ports.gateway = {
      requested: gatewayPort,
      available: await findAvailablePort(gatewayPort),
    };
    summary.checks.ports.openclaw = {
      requested: openclawPort,
      available: await findAvailablePort(openclawPort),
    };
  } catch (error) {
    const failureCategory =
      error && typeof error === "object" && "failureCategory" in error ? error.failureCategory : "ENV_CHECK_FAILED";
    const failureCode =
      error && typeof error === "object" && "failureCode" in error ? error.failureCode : failureCategory;
    summary.failure_category = failureCategory;
    summary.failure_code = failureCode;
    summary.message = error instanceof Error ? error.message : String(error);
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    console.error(`failure_category=${failureCategory}`);
    console.error(`failure_code=${failureCode}`);
    console.error(summary.message);
    process.exit(1);
  }

  summary.message = "Environment checks passed";
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log("[verify-openclaw-env] PASS");
  console.log(`summary=${summaryPath}`);
}

main().catch((error) => {
  const failure = createFailure("ENV_CHECK_FAILED", error instanceof Error ? error.message : String(error));
  console.error(`failure_category=${failure.failureCategory}`);
  console.error(`failure_code=${failure.failureCode}`);
  console.error(failure.message);
  process.exit(1);
});
