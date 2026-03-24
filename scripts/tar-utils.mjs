import { execFileSync } from "node:child_process";

export function parseTarEntriesOutput(output) {
  return String(output)
    .split(/\r?\n/)
    .map((entry) => entry.replace(/\s+$/u, ""))
    .filter(Boolean);
}

export function listTarEntries(tgzPath) {
  const output = execFileSync("tar", ["-tzf", tgzPath], {
    encoding: "utf8",
  });
  return parseTarEntriesOutput(output);
}
