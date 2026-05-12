import { networkInterfaces } from "node:os";
import type { MacAddressResolver } from "../domain/ports.ts";

export class DefaultMacAddressResolver implements MacAddressResolver {
  resolve() {
    const entries = Object.values(networkInterfaces()).flat().filter(Boolean);
    const candidate = entries.find((item) => {
      if (!item) {
        return false;
      }
      const mac = String(item.mac ?? "").trim();
      return !item.internal && mac && mac !== "00:00:00:00:00:00";
    });
    return candidate && "mac" in candidate ? candidate.mac ?? "" : "";
  }
}
