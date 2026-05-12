import { homedir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { access, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import type { PluginArtifactPort, ProcessRunner } from "../domain/ports.ts";
import type { InstalledPluginArtifact } from "../domain/types.ts";
import { InstallCliError } from "../domain/errors.ts";
import { TarballExtractor } from "./TarballExtractor.ts";

interface PackageManifest {
  main?: string;
  exports?: string | Record<string, unknown>;
}

interface FileOps {
  access(path: string): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
}

const defaultFileOps: FileOps = {
  access,
  async mkdir(path: string, options: { recursive: true }) {
    await mkdir(path, options);
  },
  mkdtemp,
  readFile,
  rename,
  rm,
};

function resolveCacheRoot(env = process.env) {
  if (env.XDG_CACHE_HOME?.trim()) {
    return join(env.XDG_CACHE_HOME.trim(), "skill-plugin-cli");
  }
  return join(env.HOME || homedir(), ".cache", "skill-plugin-cli");
}

function trimOutput(text: string) {
  return text.trim();
}

function resolveEntrypointPath(packageDir: string, manifest: PackageManifest) {
  if (typeof manifest.main === "string" && manifest.main.trim()) {
    return resolve(packageDir, manifest.main);
  }
  if (typeof manifest.exports === "string" && manifest.exports.trim()) {
    return resolve(packageDir, manifest.exports);
  }
  throw new InstallCliError("PLUGIN_ARTIFACT_INVALID", "发布包缺少可识别入口文件。");
}

async function assertFileExists(fileOps: FileOps, filePath: string, errorMessage: string) {
  try {
    await fileOps.access(filePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new InstallCliError("PLUGIN_ARTIFACT_INVALID", errorMessage);
    }
    throw error;
  }
}

/**
 * 统一 fallback 取包端口，负责版本解析、tarball 缓存与最小发布包 contract 校验。
 */
export class NpmPluginArtifactAdapter implements PluginArtifactPort {
  private readonly processRunner: ProcessRunner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fileOps: FileOps;
  private readonly tarballExtractor: TarballExtractor;

  constructor(
    processRunner: ProcessRunner,
    env = process.env,
    fileOps: FileOps = defaultFileOps,
    tarballExtractor: TarballExtractor = new TarballExtractor(),
  ) {
    this.processRunner = processRunner;
    this.env = env;
    this.fileOps = fileOps;
    this.tarballExtractor = tarballExtractor;
  }

  async fetchArtifact(input: {
    host: "opencode" | "openclaw";
    installStrategy: "host-native" | "fallback";
    packageName: string;
    registry: string;
  }): Promise<InstalledPluginArtifact> {
    if (input.installStrategy !== "fallback") {
      throw new InstallCliError("PLUGIN_ARTIFACT_INVALID", "只有 fallback 策略允许请求发布包产物。");
    }

    const versionResult = await this.processRunner.exec(
      "npm",
      ["view", input.packageName, "version", "--registry", input.registry],
      { env: this.env },
    );
    if (versionResult.exitCode !== 0) {
      throw new InstallCliError(
        "PLUGIN_ARTIFACT_FETCH_FAILED",
        trimOutput(versionResult.stderr || versionResult.stdout || `npm view ${input.packageName} 失败。`),
      );
    }

    const packageVersion = trimOutput(versionResult.stdout || versionResult.stderr);
    if (!packageVersion) {
      throw new InstallCliError("PLUGIN_ARTIFACT_INVALID", `未解析到 ${input.packageName} 的发布版本。`);
    }

    const cacheRoot = resolveCacheRoot(this.env);
    const tarballDir = resolve(cacheRoot, input.host, "tarballs");
    const extractedRoot = resolve(cacheRoot, input.host, "extracted", input.packageName, packageVersion);
    const extractedParentDir = dirname(extractedRoot);
    await this.fileOps.mkdir(tarballDir, { recursive: true });
    await this.fileOps.mkdir(extractedParentDir, { recursive: true });

    const packResult = await this.processRunner.exec(
      "npm",
      [
        "pack",
        `${input.packageName}@${packageVersion}`,
        "--pack-destination",
        tarballDir,
        "--registry",
        input.registry,
      ],
      { env: this.env },
    );
    if (packResult.exitCode !== 0) {
      throw new InstallCliError(
        "PLUGIN_ARTIFACT_FETCH_FAILED",
        trimOutput(packResult.stderr || packResult.stdout || `npm pack ${input.packageName}@${packageVersion} 失败。`),
      );
    }

    const tarballName = trimOutput(packResult.stdout.split(/\r?\n/u).filter(Boolean).pop() || "");
    if (!tarballName) {
      throw new InstallCliError("PLUGIN_ARTIFACT_INVALID", `未解析到 ${input.packageName} 的 tarball 名称。`);
    }
    const tarballPath = resolve(tarballDir, tarballName);

    const tempExtractedRoot = await this.fileOps.mkdtemp(resolve(extractedParentDir, `${packageVersion}.tmp-`));
    const backupExtractedRoot = resolve(extractedParentDir, `${packageVersion}.bak`);
    let tempRootConsumed = false;
    let backupRootCreated = false;
    try {
      await this.tarballExtractor.extract(tarballPath, tempExtractedRoot);

      const tempPackageDir = resolve(tempExtractedRoot, "package");
      const manifestPath = resolve(tempPackageDir, "package.json");
      await assertFileExists(this.fileOps, manifestPath, `发布包缺少 package.json：${manifestPath}`);
      const manifest = JSON.parse(await this.fileOps.readFile(manifestPath, "utf8")) as PackageManifest;
      const entrypointPath = resolveEntrypointPath(tempPackageDir, manifest);
      await assertFileExists(this.fileOps, entrypointPath, `发布包入口文件不存在：${entrypointPath}`);
      if (input.host === "openclaw") {
        await assertFileExists(this.fileOps, resolve(tempPackageDir, "openclaw.plugin.json"), "发布包缺少 openclaw.plugin.json。");
      }

      await this.fileOps.rm(backupExtractedRoot, { recursive: true, force: true });
      try {
        await this.fileOps.rename(extractedRoot, backupExtractedRoot);
        backupRootCreated = true;
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }

      try {
        await this.fileOps.rename(tempExtractedRoot, extractedRoot);
      } catch (error) {
        if (backupRootCreated) {
          try {
            await this.fileOps.rename(backupExtractedRoot, extractedRoot);
            backupRootCreated = false;
          } catch (rollbackError) {
            throw new InstallCliError(
              "PLUGIN_ARTIFACT_FETCH_FAILED",
              `正式缓存替换失败，且旧缓存恢复失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            );
          }
        }
        throw new InstallCliError(
          "PLUGIN_ARTIFACT_FETCH_FAILED",
          `正式缓存替换失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }

      tempRootConsumed = true;
      if (backupRootCreated) {
        await this.fileOps.rm(backupExtractedRoot, { recursive: true, force: true });
        backupRootCreated = false;
      }
    } finally {
      if (!tempRootConsumed) {
        await this.fileOps.rm(tempExtractedRoot, { recursive: true, force: true });
      }
    }

    const packageDir = resolve(extractedRoot, "package");

    return {
      installStrategy: "fallback",
      pluginSpec: input.host === "opencode" ? normalize(packageDir) : input.packageName,
      packageName: input.packageName,
      packageVersion,
      localExtractPath: normalize(packageDir),
      localTarballPath: normalize(tarballPath),
    };
  }
}
