import { mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const bundleDir = path.join(rootDir, "bundle");
const sourcePackageJsonPath = path.join(rootDir, "package.json");
const sourcePluginManifestPath = path.join(rootDir, "openclaw.plugin.json");
const sourceReadmePath = path.join(rootDir, "README.bundle.md");
const localhostDefaultGatewayUrl = "ws://localhost:8081/ws/agent";
const sourceInstallScriptPath = path.join(rootDir, "scripts", "install-openclaw-plugin.mjs");

async function main() {
  const defaultGatewayUrl = process.env.MB_DEFAULT_GATEWAY_URL?.trim() || localhostDefaultGatewayUrl;
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
    },
  });

  await build({
    entryPoints: [sourceInstallScriptPath],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    outfile: path.join(bundleDir, "install.mjs"),
  });

  const sourcePackageJson = JSON.parse(await readFile(sourcePackageJsonPath, "utf8"));
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
    files: [
      "index.js",
      "install.mjs",
      "package.json",
      "openclaw.plugin.json",
      "README.md",
    ],
    bin: "./install.mjs",
    peerDependencies: sourcePackageJson.peerDependencies,
    peerDependenciesMeta: sourcePackageJson.peerDependenciesMeta,
    openclaw: {
      ...sourcePackageJson.openclaw,
      extensions: ["./index.js"],
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
