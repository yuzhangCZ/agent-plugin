import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import path from "node:path";

import {
  computeNextVersion,
  createReleasePlan,
  evaluatePublishReadiness,
  executeRelease,
  formatHelp,
  formatReleasePlan,
  inspectManifestDependencies,
  isCliEntry,
  main,
  parseReleaseLocalArgs,
  parseSemver,
  releaseDescriptorSchema,
  releaseDescriptors,
} from "./release-local.mjs";
import { parseTarEntriesOutput } from "./tar-utils.mjs";

class FakeFs {
  constructor({ manifests = {}, existingPaths = [] } = {}) {
    this.manifests = new Map(Object.entries(manifests));
    this.existingPaths = new Set(existingPaths);
  }

  exists(targetPath) {
    return this.existingPaths.has(targetPath);
  }

  readJson(targetPath) {
    if (!this.manifests.has(targetPath)) {
      throw new Error(`missing fake manifest: ${targetPath}`);
    }

    return structuredClone(this.manifests.get(targetPath));
  }

  writeJson(targetPath, value) {
    this.manifests.set(targetPath, structuredClone(value));
    this.existingPaths.add(targetPath);
  }
}

function createCapture() {
  const chunks = [];
  return {
    stream: {
      write(chunk) {
        chunks.push(String(chunk));
      },
    },
    toString() {
      return chunks.join("");
    },
  };
}

function createExecDouble({
  repoRoot = "/repo",
  status = "",
  existingTags = new Set(),
  failCommands = [],
  scopedRegistries = {
    "@wecode:registry": "https://packages.wecode.example/",
  },
  defaultRegistry = "https://registry.example.test/",
} = {}) {
  const calls = [];
  const failureQueue = [...failCommands];

  const exec = (command, args, options = {}) => {
    calls.push({
      args: [...args],
      command,
      cwd: options.cwd,
      env: options.env ? { ...options.env } : undefined,
      stdio: options.stdio ?? "pipe",
    });

    const rendered = `${command} ${args.join(" ")}`.trim();
    const queuedFailureIndex = failureQueue.findIndex((entry) => rendered.includes(entry.match));
    if (queuedFailureIndex >= 0) {
      const [entry] = failureQueue.splice(queuedFailureIndex, 1);
      throw new Error(entry.message ?? `forced failure for ${rendered}`);
    }

    if (command === "git" && args[0] === "status" && args[1] === "--short") {
      return status;
    }

    if (command === "git" && args[0] === "rev-parse") {
      const tagName = args[3].replace("refs/tags/", "");
      if (existingTags.has(tagName)) {
        return tagName;
      }
      throw new Error("tag missing");
    }

    if (command === "git" && args[0] === "branch" && args[1] === "--show-current") {
      return "codex/release-local-cli";
    }

    if (command === "npm" && args[0] === "config" && args[1] === "get") {
      if (args[2] === "registry") {
        return defaultRegistry;
      }

      return scopedRegistries[args[2]] ?? "undefined";
    }

    if (command === "npm" && args[0] === "whoami") {
      return "release-bot";
    }

    return "";
  };

  return {
    calls,
    exec,
    repoRoot,
  };
}

function createRepoState(repoRoot = "/repo") {
  const bridgeRoot = path.join(repoRoot, "plugins/message-bridge");
  const openclawRoot = path.join(repoRoot, "plugins/message-bridge-openclaw");
  const bundleRoot = path.join(openclawRoot, "bundle");

  return {
    bridgeRoot,
    bundleRoot,
    manifests: {
      [path.join(bridgeRoot, "package.json")]: {
        name: "@wecode/skill-opencode-plugin",
        version: "1.0.0",
      },
      [path.join(openclawRoot, "package.json")]: {
        name: "@wecode/skill-openclaw-plugin",
        version: "0.1.0",
      },
      [path.join(bundleRoot, "package.json")]: {
        name: "@wecode/skill-openclaw-plugin",
        version: "0.2.0",
      },
    },
    paths: [
      bridgeRoot,
      path.join(bridgeRoot, "package.json"),
      path.join(bridgeRoot, "release"),
      path.join(bridgeRoot, "release/message-bridge.plugin.js"),
      openclawRoot,
      path.join(openclawRoot, "package.json"),
      bundleRoot,
      path.join(bundleRoot, "index.js"),
      path.join(bundleRoot, "package.json"),
      path.join(bundleRoot, "openclaw.plugin.json"),
      path.join(bundleRoot, "README.md"),
    ],
  };
}

function missingDependencyResult(targetId, missingPackages) {
  return {
    missingPackages,
    ok: false,
    targetId,
  };
}

test("descriptor schema is complete for both release targets", () => {
  for (const descriptor of Object.values(releaseDescriptors)) {
    for (const field of releaseDescriptorSchema) {
      assert.ok(field in descriptor, `missing field ${field}`);
    }
  }
});

test("parseReleaseLocalArgs accepts single-target bump release", () => {
  const parsed = parseReleaseLocalArgs(["--target", "message-bridge", "--bump", "patch"]);

  assert.deepEqual(parsed, {
    allowDirty: false,
    bridgeVersion: null,
    bump: "patch",
    defaultGatewayUrl: null,
    dryRun: false,
    help: false,
    installDeps: false,
    installDepsUpdateLockfile: false,
    openclawVersion: null,
    positionalTarget: null,
    preid: "beta",
    push: false,
    release: null,
    skipGit: false,
    skipPublish: false,
    skipVerify: false,
    target: "message-bridge",
    version: null,
  });
});

test("parseReleaseLocalArgs accepts default gateway url", () => {
  const parsed = parseReleaseLocalArgs([
    "--target",
    "message-bridge",
    "--version",
    "1.2.0",
    "--default-gateway-url",
    "wss://gateway.example.com/ws/agent",
  ]);

  assert.equal(parsed.defaultGatewayUrl, "wss://gateway.example.com/ws/agent");
});

test("parseReleaseLocalArgs rejects version plus bump", () => {
  assert.throws(
    () => parseReleaseLocalArgs(["--target", "message-bridge", "--version", "1.2.0", "--bump", "patch"]),
    /--version and --bump cannot be used together/i,
  );
});

test("parseReleaseLocalArgs rejects push plus skip-git", () => {
  assert.throws(
    () => parseReleaseLocalArgs(["--target", "message-bridge", "--bump", "patch", "--push", "--skip-git"]),
    /--push cannot be combined with --skip-git/i,
  );
});

test("parseReleaseLocalArgs rejects push plus skip-publish", () => {
  assert.throws(
    () => parseReleaseLocalArgs(["--target", "message-bridge", "--bump", "patch", "--push", "--skip-publish"]),
    /--push cannot be combined with --skip-publish/i,
  );
});

test("parseReleaseLocalArgs accepts skip-verify mode", () => {
  const parsed = parseReleaseLocalArgs(["--target", "message-bridge", "--version", "1.2.0", "--skip-verify"]);

  assert.equal(parsed.skipVerify, true);
  assert.equal(parsed.skipPublish, false);
});

test("parseReleaseLocalArgs accepts install-deps mode", () => {
  const parsed = parseReleaseLocalArgs(["--target", "message-bridge", "--version", "1.2.0", "--install-deps"]);

  assert.equal(parsed.installDeps, true);
  assert.equal(parsed.installDepsUpdateLockfile, false);
});

test("parseReleaseLocalArgs accepts install-deps-update-lockfile mode", () => {
  const parsed = parseReleaseLocalArgs([
    "--target",
    "message-bridge",
    "--version",
    "1.2.0",
    "--install-deps-update-lockfile",
  ]);

  assert.equal(parsed.installDeps, false);
  assert.equal(parsed.installDepsUpdateLockfile, true);
});

test("parseReleaseLocalArgs rejects conflicting install modes", () => {
  assert.throws(
    () =>
      parseReleaseLocalArgs([
        "--target",
        "message-bridge",
        "--version",
        "1.2.0",
        "--install-deps",
        "--install-deps-update-lockfile",
      ]),
    /cannot be used together/i,
  );
});

test("parseReleaseLocalArgs rejects invalid dual version shape", () => {
  assert.throws(
    () => parseReleaseLocalArgs(["--target", "dual", "--version", "1.2.0"]),
    /dual releases require --bridge-version and --openclaw-version/i,
  );
});

test("computeNextVersion handles prerelease increments and preid switches", () => {
  assert.equal(computeNextVersion("1.2.3", "prerelease", "beta"), "1.2.4-beta.0");
  assert.equal(computeNextVersion("1.2.4-beta.0", "prerelease", "beta"), "1.2.4-beta.1");
  assert.equal(computeNextVersion("1.2.4-beta.1", "prerelease", "rc"), "1.2.4-rc.0");
});

test("parseSemver validates versions", () => {
  assert.deepEqual(parseSemver("1.2.3-beta.4"), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: ["beta", "4"],
  });
  assert.throws(() => parseSemver("1.2"), /invalid semver/i);
});

test("parseTarEntriesOutput normalizes unix tar output", () => {
  const entries = parseTarEntriesOutput(
    [
      "package/release/message-bridge.plugin.js",
      "package/dist/debug.js",
      "package/release/message-bridge.plugin.js.map",
      "",
    ].join("\n"),
  );

  assert(entries.includes("package/release/message-bridge.plugin.js"));
  assert(entries.some((entry) => entry.startsWith("package/dist/")));
  assert(entries.some((entry) => entry.endsWith(".map")));
});

test("parseTarEntriesOutput normalizes windows tar output", () => {
  const entries = parseTarEntriesOutput(
    [
      "package/release/message-bridge.plugin.js\r",
      "package/dist/debug.js\r",
      "package/release/message-bridge.plugin.js.map\r",
      "",
    ].join("\r\n"),
  );

  assert(entries.includes("package/release/message-bridge.plugin.js"));
  assert(entries.some((entry) => entry.startsWith("package/dist/")));
  assert(entries.some((entry) => entry.endsWith(".map")));
});

test("inspectManifestDependencies ignores optional dependencies in the presence check", () => {
  const repoRoot = path.resolve("/repo");
  const packageRoot = path.join(repoRoot, "plugins/message-bridge");
  const manifestPath = path.join(packageRoot, "package.json");
  const fs = new FakeFs({
    manifests: {
      [manifestPath]: {
        name: "@wecode/skill-opencode-plugin",
        version: "1.0.0",
        dependencies: {
          "jsonc-parser": "^3.3.1",
        },
        optionalDependencies: {
          "optional-only": "^1.0.0",
        },
      },
    },
    existingPaths: [packageRoot, manifestPath],
  });
  const execCalls = [];
  const target = {
    id: "message-bridge",
    packageRootAbsolute: packageRoot,
    versionSourceAbsolute: manifestPath,
  };
  const exec = (command, args, options = {}) => {
    execCalls.push({ command, args: [...args], cwd: options.cwd });
    const dependencyNames = JSON.parse(args[3]);
    assert.deepEqual(dependencyNames, ["jsonc-parser"]);
    return JSON.stringify({ missingPackages: [] });
  };

  const result = inspectManifestDependencies(target, fs, exec);

  assert.equal(result.ok, true);
  assert.deepEqual(result.missingPackages, []);
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].command, "node");
  assert.equal(execCalls[0].cwd, packageRoot);
});

test("inspectManifestDependencies accepts package metadata fallback in the presence check", () => {
  const packageRoot = path.resolve("plugins/message-bridge");
  const manifestPath = path.join(packageRoot, "package.json");
  const fs = new FakeFs({
    manifests: {
      [manifestPath]: {
        name: "@wecode/skill-opencode-plugin",
        version: "1.0.0",
        devDependencies: {
          "@types/node": "^22.10.2",
        },
      },
    },
    existingPaths: [packageRoot, manifestPath],
  });
  const target = {
    id: "message-bridge",
    packageRootAbsolute: packageRoot,
    versionSourceAbsolute: manifestPath,
  };
  const exec = (command, args, options = {}) => {
    assert.equal(command, "node");
    assert.equal(args[0], "--input-type=module");
    assert.equal(args[1], "-e");
    return execFileSync(process.execPath, args, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  };

  const result = inspectManifestDependencies(target, fs, exec);

  assert.equal(result.ok, true);
  assert.deepEqual(result.missingPackages, []);
});

test("inspectManifestDependencies accepts workspace packages in the presence check", () => {
  const repoRoot = path.resolve("/repo");
  const packageRoot = path.join(repoRoot, "plugins/message-bridge");
  const manifestPath = path.join(packageRoot, "package.json");
  const fs = new FakeFs({
    manifests: {
      [manifestPath]: {
        name: "@wecode/skill-opencode-plugin",
        version: "1.0.0",
        devDependencies: {
          "@agent-plugin/test-support": "workspace:*",
        },
      },
    },
    existingPaths: [packageRoot, manifestPath],
  });
  const target = {
    id: "message-bridge",
    packageRootAbsolute: packageRoot,
    versionSourceAbsolute: manifestPath,
  };
  const exec = () => JSON.stringify({ missingPackages: [] });

  const result = inspectManifestDependencies(target, fs, exec);

  assert.equal(result.ok, true);
  assert.deepEqual(result.missingPackages, []);
});

test("inspectManifestDependencies reports missing packages when package metadata is unreachable", () => {
  const repoRoot = path.resolve("/repo");
  const packageRoot = path.join(repoRoot, "plugins/message-bridge");
  const manifestPath = path.join(packageRoot, "package.json");
  const fs = new FakeFs({
    manifests: {
      [manifestPath]: {
        name: "@wecode/skill-opencode-plugin",
        version: "1.0.0",
        devDependencies: {
          "missing-package": "^1.0.0",
        },
      },
    },
    existingPaths: [packageRoot, manifestPath],
  });
  const target = {
    id: "message-bridge",
    packageRootAbsolute: packageRoot,
    versionSourceAbsolute: manifestPath,
  };
  const exec = () => JSON.stringify({ missingPackages: ["missing-package"] });

  const result = inspectManifestDependencies(target, fs, exec);

  assert.equal(result.ok, false);
  assert.deepEqual(result.missingPackages, ["missing-package"]);
});

test("inspectManifestDependencies throws when the check script outputs invalid JSON", () => {
  const repoRoot = path.resolve("/repo");
  const packageRoot = path.join(repoRoot, "plugins/message-bridge");
  const manifestPath = path.join(packageRoot, "package.json");
  const fs = new FakeFs({
    manifests: {
      [manifestPath]: {
        name: "@wecode/skill-opencode-plugin",
        version: "1.0.0",
        devDependencies: {
          esbuild: "^0.25.0",
        },
      },
    },
    existingPaths: [packageRoot, manifestPath],
  });
  const target = {
    id: "message-bridge",
    packageRootAbsolute: packageRoot,
    versionSourceAbsolute: manifestPath,
  };

  assert.throws(() => inspectManifestDependencies(target, fs, () => "not-json"), /Unexpected token|not valid JSON/i);
});

test("inspectManifestDependencies surfaces node execution failures", () => {
  const repoRoot = path.resolve("/repo");
  const packageRoot = path.join(repoRoot, "plugins/message-bridge");
  const manifestPath = path.join(packageRoot, "package.json");
  const fs = new FakeFs({
    manifests: {
      [manifestPath]: {
        name: "@wecode/skill-opencode-plugin",
        version: "1.0.0",
        devDependencies: {
          esbuild: "^0.25.0",
        },
      },
    },
    existingPaths: [packageRoot, manifestPath],
  });
  const target = {
    id: "message-bridge",
    packageRootAbsolute: packageRoot,
    versionSourceAbsolute: manifestPath,
  };

  assert.throws(
    () => inspectManifestDependencies(target, fs, () => {
      throw new Error("node execution failed");
    }),
    /node execution failed/i,
  );
});

test("createReleasePlan resolves dual releases and warns they are non-atomic", () => {
  const repoRoot = path.resolve("/repo");
  const state = createRepoState(repoRoot);
  const fs = new FakeFs({
    manifests: state.manifests,
    existingPaths: state.paths,
  });
  const exec = createExecDouble({ repoRoot }).exec;

  const plan = createReleasePlan(
    {
      target: "dual",
      bump: "patch",
      preid: "beta",
      release: null,
      dryRun: true,
      push: false,
      skipGit: false,
      skipPublish: false,
      allowDirty: false,
      version: null,
      bridgeVersion: null,
      openclawVersion: null,
    },
    { repoRoot, fs, exec },
  );

  assert.equal(plan.targets[0].targetVersion, "1.0.1");
  assert.equal(plan.targets[1].targetVersion, "0.1.1");
  assert.match(formatReleasePlan(plan), /dual \(non-atomic\)/i);
});

test("formatReleasePlan shows skip-verify in dry-run output", () => {
  const repoRoot = path.resolve("/repo");
  const state = createRepoState(repoRoot);
  const fs = new FakeFs({
    manifests: state.manifests,
    existingPaths: state.paths,
  });
  const exec = createExecDouble({ repoRoot }).exec;

  const plan = createReleasePlan(
    {
      target: "message-bridge",
      version: "1.1.0",
      bump: null,
      defaultGatewayUrl: "wss://gateway.example.com/ws/agent",
      preid: "beta",
      release: null,
      dryRun: true,
      push: false,
      skipGit: true,
      skipPublish: true,
      skipVerify: true,
      allowDirty: true,
      bridgeVersion: null,
      openclawVersion: null,
    },
    { repoRoot, fs, exec },
  );

  const rendered = formatReleasePlan(plan);
  assert.match(rendered, /verify: no/i);
  assert.match(rendered, /default gateway url: wss:\/\/gateway\.example\.com\/ws\/agent/i);
  assert.match(rendered, /verify step: skipped \(\-\-skip-verify\)/i);
  assert.match(rendered, /verify was skipped by user request/i);
  assert.match(
    rendered,
    /verify steps are being skipped by user request; publish may continue without verify:release safeguards\./i,
  );
});

test("formatReleasePlan shows missing default gateway url status", () => {
  const repoRoot = path.resolve("/repo");
  const state = createRepoState(repoRoot);
  const fs = new FakeFs({
    manifests: state.manifests,
    existingPaths: state.paths,
  });
  const exec = createExecDouble({ repoRoot }).exec;

  const plan = createReleasePlan(
    {
      target: "message-bridge",
      version: "1.1.0",
      bump: null,
      preid: "beta",
      release: null,
      dryRun: true,
      push: false,
      skipGit: true,
      skipPublish: true,
      allowDirty: true,
      bridgeVersion: null,
      openclawVersion: null,
    },
    { repoRoot, fs, exec },
  );

  assert.match(formatReleasePlan(plan), /default gateway url: missing/i);
});

test("createReleasePlan rejects existing tags", () => {
  const repoRoot = path.resolve("/repo");
  const state = createRepoState(repoRoot);
  const fs = new FakeFs({
    manifests: state.manifests,
    existingPaths: state.paths,
  });
  const execDouble = createExecDouble({
    repoRoot,
    existingTags: new Set(["release/message-bridge/v1.0.1"]),
  });

  const plan = createReleasePlan(
    {
      target: "message-bridge",
      bump: "patch",
      preid: "beta",
      release: null,
      dryRun: true,
      push: false,
      skipGit: false,
      skipPublish: false,
      allowDirty: true,
      version: null,
      bridgeVersion: null,
      openclawVersion: null,
    },
    { repoRoot, fs, exec: execDouble.exec },
  );

  assert.match(formatReleasePlan(plan), /release tag already exists/i);
});

test("createReleasePlan ignores generated build outputs in dirty worktree checks", () => {
  const repoRoot = path.resolve("/repo");
  const state = createRepoState(repoRoot);
  const fs = new FakeFs({
    manifests: state.manifests,
    existingPaths: state.paths,
  });
  const exec = createExecDouble({
    repoRoot,
    status: "?? plugins/message-bridge-openclaw/bundle/package.json\n?? plugins/message-bridge-openclaw/bundle/index.js\n",
  }).exec;

  const plan = createReleasePlan(
    {
      target: "message-bridge",
      bump: "prerelease",
      preid: "beta",
      release: null,
      dryRun: true,
      push: false,
      skipGit: false,
      skipPublish: false,
      allowDirty: false,
      version: null,
      bridgeVersion: null,
      openclawVersion: null,
    },
    { repoRoot, fs, exec },
  );

  assert.doesNotMatch(formatReleasePlan(plan), /working tree is not clean/i);
});

test("createReleasePlan still blocks on non-generated dirty files", () => {
  const repoRoot = path.resolve("/repo");
  const state = createRepoState(repoRoot);
  const fs = new FakeFs({
    manifests: state.manifests,
    existingPaths: state.paths,
  });
  const exec = createExecDouble({
    repoRoot,
    status: " M README.md\n",
  }).exec;

  const plan = createReleasePlan(
    {
      target: "message-bridge",
      bump: "patch",
      preid: "beta",
      release: null,
      dryRun: true,
      push: false,
      skipGit: false,
      skipPublish: false,
      allowDirty: false,
      version: null,
      bridgeVersion: null,
      openclawVersion: null,
    },
    { repoRoot, fs, exec },
  );

  assert.match(formatReleasePlan(plan), /working tree is not clean/i);
});

test("evaluatePublishReadiness returns the publish readiness contract", () => {
  const repoRoot = path.resolve("/repo");
  const state = createRepoState(repoRoot);
  const fs = new FakeFs({
    manifests: state.manifests,
    existingPaths: state.paths,
  });
  const exec = createExecDouble({ repoRoot }).exec;
  const plan = createReleasePlan(
    {
      target: "message-bridge-openclaw",
      version: "0.2.0",
      bump: null,
      preid: "beta",
      release: null,
      dryRun: true,
      push: false,
      skipGit: false,
      skipPublish: false,
      allowDirty: true,
      bridgeVersion: null,
      openclawVersion: null,
    },
    { repoRoot, fs, exec },
  );

  const readiness = evaluatePublishReadiness(plan.targets[0], { fs });

  assert.equal(readiness.releaseReady, true);
  assert.equal(readiness.resolvedVersion, "0.2.0");
  assert.equal(readiness.resolvedDistTag, "latest");
  assert.equal(readiness.resolvedPublishRoot, path.join("plugins", "message-bridge-openclaw", "bundle"));
  assert.ok(readiness.executedChecks.length >= 4);
});

test("executeRelease skips publish and still stages git flow", () => {
  const repoRoot = path.resolve("/repo");
  const state = createRepoState(repoRoot);
  const fs = new FakeFs({
    manifests: state.manifests,
    existingPaths: state.paths,
  });
  const execDouble = createExecDouble({ repoRoot });
  const stdout = createCapture();
  const plan = createReleasePlan(
    {
      target: "message-bridge",
      version: "1.1.0",
      bump: null,
      defaultGatewayUrl: "wss://gateway.example.com/ws/agent",
      preid: "beta",
      release: null,
      dryRun: false,
      push: false,
      skipGit: false,
      skipPublish: true,
      allowDirty: true,
      bridgeVersion: null,
      openclawVersion: null,
    },
    { repoRoot, fs, exec: execDouble.exec },
  );

  const result = executeRelease(plan, { repoRoot, fs, exec: execDouble.exec, stdout: stdout.stream });

  assert.equal(result.exitCode, 0);
  assert.equal(fs.readJson(path.join(state.bridgeRoot, "package.json")).version, "1.1.0");
  assert.ok(execDouble.calls.some((entry) => entry.command === "git" && entry.args[0] === "commit"));
  assert.ok(!execDouble.calls.some((entry) => entry.command === "npm" && entry.args[0] === "publish"));
});

test("executeRelease skips verify and still runs build readiness and publish", () => {
  const repoRoot = path.resolve("/repo");
  const state = createRepoState(repoRoot);
  const fs = new FakeFs({
    manifests: state.manifests,
    existingPaths: state.paths,
  });
  const execDouble = createExecDouble({ repoRoot });
  const stdout = createCapture();
  const plan = createReleasePlan(
    {
      target: "message-bridge",
      version: "1.1.0",
      bump: null,
      defaultGatewayUrl: "wss://gateway.example.com/ws/agent",
      preid: "beta",
      release: null,
      dryRun: false,
      push: false,
      skipGit: true,
      skipPublish: false,
      skipVerify: true,
      allowDirty: true,
      bridgeVersion: null,
      openclawVersion: null,
    },
    { repoRoot, fs, exec: execDouble.exec },
  );

  const result = executeRelease(plan, { repoRoot, fs, exec: execDouble.exec, stdout: stdout.stream });

  assert.equal(result.exitCode, 0);
  assert.ok(execDouble.calls.some((entry) => entry.command === "pnpm" && entry.args.includes("build")));
  assert.ok(!execDouble.calls.some((entry) => entry.command === "pnpm" && entry.args.includes("verify:release")));
  assert.ok(execDouble.calls.some((entry) => entry.command === "npm" && entry.args[0] === "publish"));
  assert.match(stdout.toString(), /Skipping verify for message-bridge \(\-\-skip-verify\)/);
  assert.match(stdout.toString(), /publish readiness: ready/i);
});

test("executeRelease fails fast on missing packages without install flags", () => {
  const repoRoot = path.resolve("/repo");
  const state = createRepoState(repoRoot);
  const fs = new FakeFs({
    manifests: state.manifests,
    existingPaths: state.paths,
  });
  const execDouble = createExecDouble({ repoRoot });
  const stdout = createCapture();
  const plan = createReleasePlan(
    {
      target: "message-bridge",
      version: "1.1.0",
      bump: null,
      defaultGatewayUrl: "wss://gateway.example.com/ws/agent",
      preid: "beta",
      release: null,
      dryRun: false,
      push: false,
      skipGit: true,
      skipPublish: true,
      allowDirty: true,
      installDeps: false,
      installDepsUpdateLockfile: false,
      bridgeVersion: null,
      openclawVersion: null,
    },
    { repoRoot, fs, exec: execDouble.exec },
  );

  assert.throws(
    () =>
      executeRelease(plan, {
        repoRoot,
        fs,
        exec: execDouble.exec,
        stdout: stdout.stream,
        inspectDependencies: () => missingDependencyResult("message-bridge", ["esbuild"]),
      }),
    /dependency presence sanity check failed before build/i,
  );
  assert.match(
    stdout.toString(),
    /dependency presence check: failed/i,
  );
  assert.ok(!execDouble.calls.some((entry) => entry.command === "pnpm" && entry.args[0] === "--dir"));
  assert.ok(!execDouble.calls.some((entry) => entry.command === "pnpm" && entry.args[0] === "install"));
});

test("executeRelease installs missing packages with frozen lockfile mode", () => {
  const repoRoot = path.resolve("/repo");
  const state = createRepoState(repoRoot);
  const fs = new FakeFs({
    manifests: state.manifests,
    existingPaths: state.paths,
  });
  const execDouble = createExecDouble({ repoRoot });
  const stdout = createCapture();
  const plan = createReleasePlan(
    {
      target: "message-bridge",
      version: "1.1.0",
      bump: null,
      defaultGatewayUrl: "wss://gateway.example.com/ws/agent",
      preid: "beta",
      release: null,
      dryRun: false,
      push: false,
      skipGit: true,
      skipPublish: true,
      allowDirty: true,
      installDeps: true,
      installDepsUpdateLockfile: false,
      bridgeVersion: null,
      openclawVersion: null,
    },
    { repoRoot, fs, exec: execDouble.exec },
  );

  const result = executeRelease(plan, {
    repoRoot,
    fs,
    exec: execDouble.exec,
    stdout: stdout.stream,
    inspectDependencies: () => {
      const installAttempted = execDouble.calls.some(
        (entry) => entry.command === "pnpm" && entry.args[0] === "install" && entry.args.includes("--frozen-lockfile"),
      );
      return installAttempted ? { missingPackages: [], ok: true, targetId: "message-bridge" } : missingDependencyResult("message-bridge", ["esbuild"]);
    },
  });

  assert.equal(result.exitCode, 0);
  assert.ok(
    execDouble.calls.some(
      (entry) =>
        entry.command === "pnpm" &&
        entry.cwd === repoRoot &&
        entry.args[0] === "install" &&
        entry.args.includes("--frozen-lockfile"),
    ),
  );
  assert.ok(execDouble.calls.some((entry) => entry.command === "pnpm" && entry.args[0] === "--dir"));
});

test("executeRelease installs missing packages with update-lockfile mode", () => {
  const repoRoot = path.resolve("/repo");
  const state = createRepoState(repoRoot);
  const fs = new FakeFs({
    manifests: state.manifests,
    existingPaths: state.paths,
  });
  const execDouble = createExecDouble({ repoRoot });
  const stdout = createCapture();
  const plan = createReleasePlan(
    {
      target: "message-bridge",
      version: "1.1.0",
      bump: null,
      defaultGatewayUrl: "wss://gateway.example.com/ws/agent",
      preid: "beta",
      release: null,
      dryRun: false,
      push: false,
      skipGit: true,
      skipPublish: true,
      allowDirty: true,
      installDeps: false,
      installDepsUpdateLockfile: true,
      bridgeVersion: null,
      openclawVersion: null,
    },
    { repoRoot, fs, exec: execDouble.exec },
  );

  const result = executeRelease(plan, {
    repoRoot,
    fs,
    exec: execDouble.exec,
    stdout: stdout.stream,
    inspectDependencies: () => {
      const installAttempted = execDouble.calls.some(
        (entry) => entry.command === "pnpm" && entry.args[0] === "install" && !entry.args.includes("--frozen-lockfile"),
      );
      return installAttempted ? { missingPackages: [], ok: true, targetId: "message-bridge" } : missingDependencyResult("message-bridge", ["esbuild"]);
    },
  });

  assert.equal(result.exitCode, 0);
  assert.ok(
    execDouble.calls.some(
      (entry) =>
        entry.command === "pnpm" &&
        entry.cwd === repoRoot &&
        entry.args.length === 1 &&
        entry.args[0] === "install",
    ),
  );
});

test("executeRelease does not install when dependency presence already passes", () => {
  const repoRoot = path.resolve("/repo");
  const state = createRepoState(repoRoot);
  const fs = new FakeFs({
    manifests: state.manifests,
    existingPaths: state.paths,
  });
  const execDouble = createExecDouble({ repoRoot });
  const stdout = createCapture();
  const plan = createReleasePlan(
    {
      target: "message-bridge",
      version: "1.1.0",
      bump: null,
      defaultGatewayUrl: "wss://gateway.example.com/ws/agent",
      preid: "beta",
      release: null,
      dryRun: false,
      push: false,
      skipGit: true,
      skipPublish: true,
      allowDirty: true,
      installDeps: true,
      installDepsUpdateLockfile: false,
      bridgeVersion: null,
      openclawVersion: null,
    },
    { repoRoot, fs, exec: execDouble.exec },
  );

  const result = executeRelease(plan, {
    repoRoot,
    fs,
    exec: execDouble.exec,
    stdout: stdout.stream,
    inspectDependencies: () => ({ missingPackages: [], ok: true, targetId: "message-bridge" }),
  });

  assert.equal(result.exitCode, 0);
  assert.ok(!execDouble.calls.some((entry) => entry.command === "pnpm" && entry.args[0] === "install"));
});

test("executeRelease stops if packages are still missing after install", () => {
  const repoRoot = path.resolve("/repo");
  const state = createRepoState(repoRoot);
  const fs = new FakeFs({
    manifests: state.manifests,
    existingPaths: state.paths,
  });
  const execDouble = createExecDouble({ repoRoot });
  const stdout = createCapture();
  const plan = createReleasePlan(
    {
      target: "message-bridge",
      version: "1.1.0",
      bump: null,
      defaultGatewayUrl: "wss://gateway.example.com/ws/agent",
      preid: "beta",
      release: null,
      dryRun: false,
      push: false,
      skipGit: true,
      skipPublish: true,
      allowDirty: true,
      installDeps: true,
      installDepsUpdateLockfile: false,
      bridgeVersion: null,
      openclawVersion: null,
    },
    { repoRoot, fs, exec: execDouble.exec },
  );

  assert.throws(
    () =>
      executeRelease(plan, {
        repoRoot,
        fs,
        exec: execDouble.exec,
        stdout: stdout.stream,
        inspectDependencies: () => missingDependencyResult("message-bridge", ["esbuild"]),
      }),
    /dependency presence sanity check failed before build/i,
  );
  assert.ok(execDouble.calls.some((entry) => entry.command === "pnpm" && entry.args[0] === "install"));
  assert.ok(!execDouble.calls.some((entry) => entry.command === "pnpm" && entry.args[0] === "--dir"));
});

test("executeRelease blocks publish when readiness fails", () => {
  const repoRoot = path.resolve("/repo");
  const state = createRepoState(repoRoot);
  const missingPaths = state.paths.filter(
    (entry) => entry !== path.join(state.bridgeRoot, "release/message-bridge.plugin.js"),
  );
  const fs = new FakeFs({
    manifests: state.manifests,
    existingPaths: missingPaths,
  });
  const execDouble = createExecDouble({ repoRoot });
  const stdout = createCapture();
  const plan = createReleasePlan(
    {
      target: "message-bridge",
      version: "1.1.0",
      bump: null,
      defaultGatewayUrl: "wss://gateway.example.com/ws/agent",
      preid: "beta",
      release: null,
      dryRun: false,
      push: false,
      skipGit: true,
      skipPublish: false,
      allowDirty: true,
      bridgeVersion: null,
      openclawVersion: null,
    },
    { repoRoot, fs, exec: execDouble.exec },
  );

  const result = executeRelease(plan, { repoRoot, fs, exec: execDouble.exec, stdout: stdout.stream });

  assert.equal(result.exitCode, 1);
  assert.equal(fs.readJson(path.join(state.bridgeRoot, "package.json")).version, "1.0.0");
  assert.ok(!execDouble.calls.some((entry) => entry.command === "npm" && entry.args[0] === "publish"));
  assert.match(stdout.toString(), /publish readiness: blocked/i);
});

test("executeRelease still blocks publish when readiness fails under skip-verify", () => {
  const repoRoot = path.resolve("/repo");
  const state = createRepoState(repoRoot);
  const missingPaths = state.paths.filter(
    (entry) => entry !== path.join(state.bridgeRoot, "release/message-bridge.plugin.js"),
  );
  const fs = new FakeFs({
    manifests: state.manifests,
    existingPaths: missingPaths,
  });
  const execDouble = createExecDouble({ repoRoot });
  const stdout = createCapture();
  const plan = createReleasePlan(
    {
      target: "message-bridge",
      version: "1.1.0",
      bump: null,
      defaultGatewayUrl: "wss://gateway.example.com/ws/agent",
      preid: "beta",
      release: null,
      dryRun: false,
      push: false,
      skipGit: true,
      skipPublish: false,
      skipVerify: true,
      allowDirty: true,
      bridgeVersion: null,
      openclawVersion: null,
    },
    { repoRoot, fs, exec: execDouble.exec },
  );

  const result = executeRelease(plan, { repoRoot, fs, exec: execDouble.exec, stdout: stdout.stream });

  assert.equal(result.exitCode, 1);
  assert.equal(fs.readJson(path.join(state.bridgeRoot, "package.json")).version, "1.0.0");
  assert.ok(!execDouble.calls.some((entry) => entry.command === "pnpm" && entry.args.includes("verify:release")));
  assert.ok(!execDouble.calls.some((entry) => entry.command === "npm" && entry.args[0] === "publish"));
  assert.match(stdout.toString(), /Skipping verify for message-bridge \(\-\-skip-verify\)/);
  assert.match(stdout.toString(), /publish readiness: blocked/i);
});

test("executeRelease restores bumped version when verify fails before publish", () => {
  const repoRoot = path.resolve("/repo");
  const state = createRepoState(repoRoot);
  const fs = new FakeFs({
    manifests: state.manifests,
    existingPaths: state.paths,
  });
  const execDouble = createExecDouble({
    repoRoot,
    failCommands: [{ match: "pnpm --dir plugins/message-bridge run verify:release", message: "verify failed" }],
  });
  const stdout = createCapture();
  const plan = createReleasePlan(
    {
      target: "message-bridge",
      bump: "patch",
      version: null,
      defaultGatewayUrl: "wss://gateway.example.com/ws/agent",
      preid: "beta",
      release: null,
      dryRun: false,
      push: false,
      skipGit: true,
      skipPublish: false,
      allowDirty: true,
      bridgeVersion: null,
      openclawVersion: null,
    },
    { repoRoot, fs, exec: execDouble.exec },
  );

  assert.throws(
    () => executeRelease(plan, { repoRoot, fs, exec: execDouble.exec, stdout: stdout.stream }),
    /verify failed/i,
  );
  assert.equal(fs.readJson(path.join(state.bridgeRoot, "package.json")).version, "1.0.0");
  assert.ok(!execDouble.calls.some((entry) => entry.command === "npm" && entry.args[0] === "publish"));
});

test("executeRelease preserves existing recovery semantics when publish fails under skip-verify", () => {
  const repoRoot = path.resolve("/repo");
  const state = createRepoState(repoRoot);
  const fs = new FakeFs({
    manifests: state.manifests,
    existingPaths: state.paths,
  });
  const execDouble = createExecDouble({
    repoRoot,
    failCommands: [{ match: "npm publish --tag latest", message: "publish failed" }],
  });
  const stdout = createCapture();
  const plan = createReleasePlan(
    {
      target: "message-bridge",
      version: "1.1.0",
      bump: null,
      defaultGatewayUrl: "wss://gateway.example.com/ws/agent",
      preid: "beta",
      release: null,
      dryRun: false,
      push: false,
      skipGit: true,
      skipPublish: false,
      skipVerify: true,
      allowDirty: true,
      bridgeVersion: null,
      openclawVersion: null,
    },
    { repoRoot, fs, exec: execDouble.exec },
  );

  assert.throws(
    () => executeRelease(plan, { repoRoot, fs, exec: execDouble.exec, stdout: stdout.stream }),
    /publish failed/i,
  );
  assert.equal(fs.readJson(path.join(state.bridgeRoot, "package.json")).version, "1.1.0");
  assert.match(stdout.toString(), /Skipping verify for message-bridge \(\-\-skip-verify\)/);
});

test("executeRelease resolves scoped registry and publishes against that registry", () => {
  const repoRoot = path.resolve("/repo");
  const state = createRepoState(repoRoot);
  const fs = new FakeFs({
    manifests: state.manifests,
    existingPaths: state.paths,
  });
  const execDouble = createExecDouble({
    repoRoot,
    scopedRegistries: {
      "@wecode:registry": "https://private-registry.wecode.test/",
    },
    defaultRegistry: "https://registry.npmjs.org/",
  });
  const stdout = createCapture();
  const plan = createReleasePlan(
    {
      target: "message-bridge",
      version: "1.1.0",
      bump: null,
      defaultGatewayUrl: "wss://gateway.example.com/ws/agent",
      preid: "beta",
      release: null,
      dryRun: false,
      push: false,
      skipGit: true,
      skipPublish: false,
      allowDirty: true,
      bridgeVersion: null,
      openclawVersion: null,
    },
    { repoRoot, fs, exec: execDouble.exec },
  );

  const result = executeRelease(plan, { repoRoot, fs, exec: execDouble.exec, stdout: stdout.stream });

  assert.equal(result.exitCode, 0);
  assert.ok(
    execDouble.calls.some(
      (entry) =>
        entry.command === "npm" &&
        entry.args[0] === "config" &&
        entry.args[1] === "get" &&
        entry.args[2] === "@wecode:registry",
    ),
  );
  assert.ok(
    execDouble.calls.some(
      (entry) =>
        entry.command === "npm" &&
        entry.args[0] === "whoami" &&
        entry.args[1] === "--registry" &&
        entry.args[2] === "https://private-registry.wecode.test/",
    ),
  );
  assert.ok(
    execDouble.calls.some(
      (entry) =>
        entry.command === "npm" &&
        entry.args[0] === "publish" &&
        entry.args.includes("--registry") &&
        entry.args.includes("https://private-registry.wecode.test/"),
    ),
  );
});

test("executeRelease surfaces dual release non-atomic recovery on second publish failure", () => {
  const repoRoot = path.resolve("/repo");
  const state = createRepoState(repoRoot);
  const fs = new FakeFs({
    manifests: state.manifests,
    existingPaths: state.paths,
  });
  const execDouble = createExecDouble({
    repoRoot,
    failCommands: [{ match: "npm publish --tag latest", message: "second publish failed" }],
  });
  const stdout = createCapture();
  const plan = createReleasePlan(
    {
      target: "dual",
      bridgeVersion: "1.1.0",
      openclawVersion: "0.2.0",
      defaultGatewayUrl: "wss://gateway.example.com/ws/agent",
      bump: null,
      preid: "beta",
      release: null,
      dryRun: false,
      push: false,
      skipGit: true,
      skipPublish: false,
      allowDirty: true,
      version: null,
    },
    { repoRoot, fs, exec: execDouble.exec },
  );

  assert.throws(
    () => executeRelease(plan, { repoRoot, fs, exec: execDouble.exec, stdout: stdout.stream }),
    /second publish failed/i,
  );
  assert.match(stdout.toString(), /may already be published/i);
});

test("executeRelease skips verify for both targets in dual mode", () => {
  const repoRoot = path.resolve("/repo");
  const state = createRepoState(repoRoot);
  const fs = new FakeFs({
    manifests: state.manifests,
    existingPaths: state.paths,
  });
  const execDouble = createExecDouble({ repoRoot });
  const stdout = createCapture();
  const plan = createReleasePlan(
    {
      target: "dual",
      bridgeVersion: "1.1.0",
      openclawVersion: "0.2.0",
      defaultGatewayUrl: "wss://gateway.example.com/ws/agent",
      bump: null,
      preid: "beta",
      release: null,
      dryRun: false,
      push: false,
      skipGit: true,
      skipPublish: true,
      skipVerify: true,
      allowDirty: true,
      version: null,
    },
    { repoRoot, fs, exec: execDouble.exec },
  );

  const result = executeRelease(plan, { repoRoot, fs, exec: execDouble.exec, stdout: stdout.stream });

  assert.equal(result.exitCode, 0);
  assert.ok(!execDouble.calls.some((entry) => entry.command === "pnpm" && entry.args.includes("verify:release")));
  assert.match(stdout.toString(), /Skipping verify for message-bridge \(\-\-skip-verify\)/);
  assert.match(stdout.toString(), /Skipping verify for message-bridge-openclaw \(\-\-skip-verify\)/);
});

test("executeRelease fails before build when default gateway url is missing", () => {
  const repoRoot = path.resolve("/repo");
  const state = createRepoState(repoRoot);
  const fs = new FakeFs({
    manifests: state.manifests,
    existingPaths: state.paths,
  });
  const execDouble = createExecDouble({ repoRoot });
  const stdout = createCapture();
  const plan = createReleasePlan(
    {
      target: "message-bridge",
      version: "1.1.0",
      bump: null,
      preid: "beta",
      release: null,
      dryRun: false,
      push: false,
      skipGit: true,
      skipPublish: true,
      allowDirty: true,
      bridgeVersion: null,
      openclawVersion: null,
    },
    { repoRoot, fs, exec: execDouble.exec },
  );

  assert.throws(
    () =>
      executeRelease(plan, {
        repoRoot,
        fs,
        exec: execDouble.exec,
        stdout: stdout.stream,
        inspectDependencies: () => ({ missingPackages: [], ok: true, targetId: "message-bridge" }),
      }),
    /default gateway url/i,
  );
  assert.match(stdout.toString(), /dependency presence check: passed/i);
  assert.ok(!execDouble.calls.some((entry) => entry.command === "pnpm" && entry.args.includes("build")));
});

test("executeRelease fails before build when default gateway url is invalid", () => {
  const repoRoot = path.resolve("/repo");
  const state = createRepoState(repoRoot);
  const fs = new FakeFs({
    manifests: state.manifests,
    existingPaths: state.paths,
  });
  const execDouble = createExecDouble({ repoRoot });
  const stdout = createCapture();
  const plan = createReleasePlan(
    {
      target: "message-bridge",
      version: "1.1.0",
      bump: null,
      defaultGatewayUrl: "https://gateway.example.com/ws/agent",
      preid: "beta",
      release: null,
      dryRun: false,
      push: false,
      skipGit: true,
      skipPublish: true,
      allowDirty: true,
      bridgeVersion: null,
      openclawVersion: null,
    },
    { repoRoot, fs, exec: execDouble.exec },
  );

  assert.throws(
    () =>
      executeRelease(plan, {
        repoRoot,
        fs,
        exec: execDouble.exec,
        stdout: stdout.stream,
        inspectDependencies: () => ({ missingPackages: [], ok: true, targetId: "message-bridge" }),
      }),
    /ws:\/\/ or wss:\/\//i,
  );
  assert.match(stdout.toString(), /dependency presence check: passed/i);
  assert.ok(!execDouble.calls.some((entry) => entry.command === "pnpm" && entry.args.includes("build")));
});

test("executeRelease fails before build when registry auth check fails", () => {
  const repoRoot = path.resolve("/repo");
  const state = createRepoState(repoRoot);
  const fs = new FakeFs({
    manifests: state.manifests,
    existingPaths: state.paths,
  });
  const execDouble = createExecDouble({
    repoRoot,
    failCommands: [{ match: "npm whoami --registry", message: "auth failed" }],
  });
  const stdout = createCapture();
  const plan = createReleasePlan(
    {
      target: "message-bridge",
      version: "1.1.0",
      bump: null,
      defaultGatewayUrl: "wss://gateway.example.com/ws/agent",
      preid: "beta",
      release: null,
      dryRun: false,
      push: false,
      skipGit: true,
      skipPublish: false,
      allowDirty: true,
      bridgeVersion: null,
      openclawVersion: null,
    },
    { repoRoot, fs, exec: execDouble.exec },
  );

  assert.throws(
    () =>
      executeRelease(plan, {
        repoRoot,
        fs,
        exec: execDouble.exec,
        stdout: stdout.stream,
        inspectDependencies: () => ({ missingPackages: [], ok: true, targetId: "message-bridge" }),
      }),
    /auth failed/i,
  );
  assert.ok(!execDouble.calls.some((entry) => entry.command === "pnpm" && entry.args.includes("build")));
});

test("executeRelease forwards MB_DEFAULT_GATEWAY_URL to build and verify for dual releases", () => {
  const repoRoot = path.resolve("/repo");
  const state = createRepoState(repoRoot);
  const fs = new FakeFs({
    manifests: state.manifests,
    existingPaths: state.paths,
  });
  const execDouble = createExecDouble({ repoRoot });
  const stdout = createCapture();
  const gatewayUrl = "wss://gateway.example.com/ws/agent";
  const plan = createReleasePlan(
    {
      target: "dual",
      bridgeVersion: "1.1.0",
      openclawVersion: "0.2.0",
      bump: null,
      defaultGatewayUrl: gatewayUrl,
      preid: "beta",
      release: null,
      dryRun: false,
      push: false,
      skipGit: true,
      skipPublish: true,
      skipVerify: false,
      allowDirty: true,
      version: null,
    },
    { repoRoot, fs, exec: execDouble.exec },
  );

  const result = executeRelease(plan, {
    repoRoot,
    fs,
    exec: execDouble.exec,
    stdout: stdout.stream,
    inspectDependencies: () => ({ missingPackages: [], ok: true, targetId: "message-bridge" }),
  });

  assert.equal(result.exitCode, 0);
  const buildAndVerifyCalls = execDouble.calls.filter(
    (entry) => entry.command === "pnpm" && (entry.args.includes("build") || entry.args.includes("verify:release")),
  );
  assert.equal(buildAndVerifyCalls.length >= 4, true);
  for (const call of buildAndVerifyCalls) {
    assert.equal(call.env?.MB_DEFAULT_GATEWAY_URL, gatewayUrl);
  }
  assert.match(stdout.toString(), /default gateway url: wss:\/\/gateway\.example\.com\/ws\/agent/i);
});

test("main prints help output", async () => {
  const stdout = createCapture();
  const stderr = createCapture();

  const exitCode = await main(["--help"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  assert.match(stdout.toString(), /pnpm release:local -- --target/i);
  assert.match(stdout.toString(), /--default-gateway-url <url>/i);
  assert.match(stdout.toString(), /--skip-verify/);
  assert.match(stdout.toString(), /--install-deps/);
  assert.match(stdout.toString(), /presence sanity check/i);
  assert.match(stdout.toString(), /official release path requires --default-gateway-url/i);
  assert.match(stdout.toString(), /pnpm install --frozen-lockfile/);
  assert.match(stdout.toString(), /--skip-verify only skips verify:release; it does not skip build or readiness checks/i);
  assert.match(formatHelp(), /remote push only runs with --push/i);
});

test("release workflows validate and forward MB_DEFAULT_GATEWAY_URL", () => {
  for (const workflowPath of [
    path.resolve(".github/workflows/release-message-bridge.yml"),
    path.resolve(".github/workflows/release-message-bridge-openclaw.yml"),
  ]) {
    const content = readFileSync(workflowPath, "utf8");
    assert.match(content, /MB_DEFAULT_GATEWAY_URL:\s*\$\{\{\s*vars\.MB_DEFAULT_GATEWAY_URL\s*\}\}/i);
    assert.match(content, /Validate default gateway url/i);
    assert.match(content, /MB_DEFAULT_GATEWAY_URL is required/i);
  }
});

test("isCliEntry normalizes argv paths before comparing ESM entry files", () => {
  if (process.platform === "win32") {
    assert.equal(
      isCliEntry("file:///C:/repo/scripts/release-local.mjs", "C:\\repo\\scripts\\release-local.mjs"),
      true,
    );
    assert.equal(
      isCliEntry("file:///C:/repo/scripts/release-local.mjs", ".\\scripts\\release-local.mjs", "C:\\repo"),
      true,
    );
    assert.equal(
      isCliEntry("file:///C:/repo/scripts/release-local.mjs", "D:\\repo\\scripts\\release-local.mjs"),
      false,
    );
    return;
  }

  assert.equal(isCliEntry("file:///repo/scripts/release-local.mjs", "/repo/scripts/release-local.mjs"), true);
});
