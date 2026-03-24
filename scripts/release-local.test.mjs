import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import {
  computeNextVersion,
  createReleasePlan,
  evaluatePublishReadiness,
  executeRelease,
  formatHelp,
  formatReleasePlan,
  isCliEntry,
  main,
  parseReleaseLocalArgs,
  parseSemver,
  releaseDescriptorSchema,
  releaseDescriptors,
} from "./release-local.mjs";

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
    dryRun: false,
    help: false,
    openclawVersion: null,
    positionalTarget: null,
    preid: "beta",
    push: false,
    release: null,
    skipGit: false,
    skipPublish: false,
    target: "message-bridge",
    version: null,
  });
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

test("createReleasePlan resolves dual releases and warns they are non-atomic", () => {
  const repoRoot = "/repo";
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

test("createReleasePlan rejects existing tags", () => {
  const repoRoot = "/repo";
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
  const repoRoot = "/repo";
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
  const repoRoot = "/repo";
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
  const repoRoot = "/repo";
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
  assert.equal(readiness.resolvedPublishRoot, "plugins/message-bridge-openclaw/bundle");
  assert.ok(readiness.executedChecks.length >= 4);
});

test("executeRelease skips publish and still stages git flow", () => {
  const repoRoot = "/repo";
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

test("executeRelease blocks publish when readiness fails", () => {
  const repoRoot = "/repo";
  const state = createRepoState(repoRoot);
  const missingPaths = state.paths.filter((entry) => !entry.endsWith("release/message-bridge.plugin.js"));
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

test("executeRelease restores bumped version when verify fails before publish", () => {
  const repoRoot = "/repo";
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

test("executeRelease resolves scoped registry and publishes against that registry", () => {
  const repoRoot = "/repo";
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
  const repoRoot = "/repo";
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
  assert.match(formatHelp(), /remote push only runs with --push/i);
});

test("isCliEntry normalizes argv paths before comparing ESM entry files", () => {
  assert.equal(isCliEntry("file:///repo/scripts/release-local.mjs", "/repo/scripts/release-local.mjs"), true);
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
});
