import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

export async function readOptionalTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeFileAtomically(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempDir = await mkdtemp(join(tmpdir(), "skill-plugin-cli-"));
  const tempPath = join(tempDir, "config.tmp");
  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, filePath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
