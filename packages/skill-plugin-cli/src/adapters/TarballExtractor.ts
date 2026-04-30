import { basename } from "node:path";
import { extract as extractTar } from "tar";
import { InstallCliError } from "../domain/errors.ts";

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 在 Node 进程内完成 `.tgz` 解包，避免 fallback 运行时依赖宿主系统 `tar`。
 */
export class TarballExtractor {
  /**
   * 将发布包解压到目标目录；任何解包失败都统一收口为取包失败。
   *
   * @param tgzPath `.tgz` 文件路径
   * @param targetDir 解包目标目录
   * @throws {InstallCliError} 当解包失败时抛出 `PLUGIN_ARTIFACT_FETCH_FAILED`
   */
  async extract(tgzPath: string, targetDir: string) {
    try {
      await extractTar({ file: tgzPath, cwd: targetDir });
    } catch (error) {
      throw new InstallCliError(
        "PLUGIN_ARTIFACT_FETCH_FAILED",
        `解包 ${basename(tgzPath)} 失败：${toErrorMessage(error)}`,
      );
    }
  }
}
