import { promises as fs } from 'node:fs';
import type { AssiantDirectoryMappingPort } from '../port/AssiantDirectoryMappingPort.js';
import type { BridgeLogger } from '../runtime/AppLogger.js';
import { getErrorDetailsForLog, getErrorMessage } from '../utils/error.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export class JsonAssiantDirectoryMappingAdapter implements AssiantDirectoryMappingPort {
  constructor(
    private readonly filePath = process.env.BRIDGE_ASSIANT_DIRECTORY_MAP_FILE?.trim(),
    private readonly loggerProvider: () => BridgeLogger | undefined = () => undefined,
  ) {}

  async resolveDirectory(assiantId: string): Promise<string | undefined> {
    // Intentionally load on every lookup so runtime updates to the mapping file
    // are visible immediately without restarting the plugin process.
    const map = await this.readMap();
    const key = normalizeString(assiantId);
    if (!key) {
      return undefined;
    }
    return map.get(key);
  }

  private async readMap(): Promise<Map<string, string>> {
    if (!this.filePath) {
      return new Map();
    }

    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(content);
      if (!isRecord(parsed)) {
        this.loggerProvider()?.warn('assiant.directory_map.invalid_shape', {
          filePath: this.filePath,
          reason: 'root_not_object',
        });
        return new Map();
      }

      const mapping = new Map<string, string>();
      for (const [assiantId, directory] of Object.entries(parsed)) {
        const normalizedAssiantId = normalizeString(assiantId);
        const normalizedDirectory = normalizeString(directory);
        if (!normalizedAssiantId || !normalizedDirectory) {
          this.loggerProvider()?.warn('assiant.directory_map.invalid_entry', {
            filePath: this.filePath,
            assiantId,
            hasDirectory: typeof directory === 'string',
          });
          continue;
        }
        mapping.set(normalizedAssiantId, normalizedDirectory);
      }

      this.loggerProvider()?.info('assiant.directory_map.loaded', {
        filePath: this.filePath,
        entryCount: mapping.size,
      });
      return mapping;
    } catch (error) {
      this.loggerProvider()?.warn('assiant.directory_map.load_failed', {
        filePath: this.filePath,
        error: getErrorMessage(error),
        ...getErrorDetailsForLog(error),
      });
      return new Map();
    }
  }
}
