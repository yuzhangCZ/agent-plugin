import { mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const bundleDir = path.join(rootDir, "bundle");
const sourcePackageJsonPath = path.join(rootDir, "package.json");
const sdkPackageJsonPath = path.resolve(rootDir, "..", "..", "packages", "bridge-runtime-sdk", "package.json");
const sdkPackageName = "@wecode/bridge-runtime-sdk";
const sourcePluginManifestPath = path.join(rootDir, "openclaw.plugin.json");
const sourceReadmePath = path.join(rootDir, "README.bundle.md");
const localhostDefaultGatewayUrl = "ws://localhost:8081/ws/agent";

async function main() {
  const defaultGatewayUrl = process.env.MB_DEFAULT_GATEWAY_URL?.trim() || localhostDefaultGatewayUrl;
  const sourcePackageJson = JSON.parse(await readFile(sourcePackageJsonPath, "utf8"));
  const packageVersion = typeof sourcePackageJson.version === "string" ? sourcePackageJson.version.trim() : "";
  if (!packageVersion) {
    throw new Error(`package.json version is missing: ${sourcePackageJsonPath}`);
  }
  const sdkPackageJson = JSON.parse(await readFile(sdkPackageJsonPath, "utf8"));
  if (sdkPackageJson.name !== sdkPackageName) {
    throw new Error(`unexpected SDK package name in ${sdkPackageJsonPath}: ${sdkPackageJson.name}`);
  }
  const sdkPackageVersion = typeof sdkPackageJson.version === "string" ? sdkPackageJson.version.trim() : "";
  if (!sdkPackageVersion) {
    throw new Error(`package.json version is missing: ${sdkPackageJsonPath}`);
  }
  await rm(bundleDir, { recursive: true, force: true });
  await mkdir(bundleDir, { recursive: true });

  await build({
    entryPoints: [path.join(rootDir, "src", "index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    outfile: path.join(bundleDir, "index.js"),
    external: ["openclaw", "openclaw/*"],
    define: {
      "globalThis.__MB_DEFAULT_GATEWAY_URL__": JSON.stringify(defaultGatewayUrl),
      "globalThis.__MB_PLUGIN_PACKAGE_VERSION__": JSON.stringify(packageVersion),
      "globalThis.__MB_SDK_PACKAGE_VERSION__": JSON.stringify(sdkPackageVersion),
    },
  });

  await build({
    entryPoints: [path.join(rootDir, "src", "setup-entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    outfile: path.join(bundleDir, "setup-entry.js"),
    external: ["openclaw", "openclaw/*"],
    define: {
      "globalThis.__MB_DEFAULT_GATEWAY_URL__": JSON.stringify(defaultGatewayUrl),
    },
  });

  const bundlePackageJson = {
    name: sourcePackageJson.name,
    version: sourcePackageJson.version,
    description: sourcePackageJson.description,
    license: "MIT",
    type: sourcePackageJson.type,
    main: "index.js",
    exports: {
      ".": {
        default: "./index.js",
      },
    },
    files: ["index.js", "setup-entry.js", "package.json", "openclaw.plugin.json", "README.md"],
    peerDependencies: sourcePackageJson.peerDependencies,
    peerDependenciesMeta: sourcePackageJson.peerDependenciesMeta,
    openclaw: {
      ...sourcePackageJson.openclaw,
      extensions: ["./index.js"],
      setupEntry: "./setup-entry.js",
    },
  };

  await writeFile(
    path.join(bundleDir, "package.json"),
    `${JSON.stringify(bundlePackageJson, null, 2)}\n`,
    "utf8",
  );

  await copyFile(sourcePluginManifestPath, path.join(bundleDir, "openclaw.plugin.json"));
  await copyFile(sourceReadmePath, path.join(bundleDir, "README.md"));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
