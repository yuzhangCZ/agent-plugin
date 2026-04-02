import { promises as fs } from 'node:fs';
import type { AssiantDirectoryMappingPort } from '../port/AssiantDirectoryMappingPort.js';
import type { BridgeLogger } from '../runtime/AppLogger.js';
import { getErrorDetailsForLog, getErrorMessage } from '../utils/error.js';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function getEntryType(value: unknown): string {
  if (Array.isArray(value)) {
    return 'array';
  }
  if (value === null) {
    return 'null';
  }
  return typeof value;
}

export class JsonAssiantDirectoryMappingAdapter implements AssiantDirectoryMappingPort {
  constructor(
    private readonly filePath = process.env.BRIDGE_ASSISTANT_DIRECTORY_MAP_FILE?.trim(),
    private readonly loggerProvider: () => BridgeLogger | undefined = () => undefined,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.filePath);
  }

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
    if (!this.isConfigured()) {
      return new Map();
    }
    const filePath = this.filePath;
    if (!filePath) {
      return new Map();
    }

    try {
      const content = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(content);
      if (!isPlainRecord(parsed)) {
        this.loggerProvider()?.warn('assiant.directory_map.invalid_shape', {
          filePath,
          reason: 'root_not_object',
          rootType: getEntryType(parsed),
        });
        return new Map();
      }

      const mapping = new Map<string, string>();
      for (const [assiantId, entry] of Object.entries(parsed)) {
        const normalizedAssiantId = normalizeString(assiantId);
        if (!normalizedAssiantId) {
          this.loggerProvider()?.warn('assiant.directory_map.invalid_entry', {
            filePath,
            assiantId,
            entryType: getEntryType(entry),
            isLegacyFlatString: false,
            hasValidAssiantId: false,
          });
          continue;
        }

        if (typeof entry === 'string') {
          this.loggerProvider()?.warn('assiant.directory_map.invalid_entry', {
            filePath,
            assiantId,
            entryType: 'string',
            isLegacyFlatString: true,
            hasValidAssiantId: true,
          });
          continue;
        }

        if (!isPlainRecord(entry)) {
          this.loggerProvider()?.warn('assiant.directory_map.invalid_entry', {
            filePath,
            assiantId,
            entryType: getEntryType(entry),
            isLegacyFlatString: false,
            hasValidAssiantId: true,
          });
          continue;
        }

        const normalizedDirectory = normalizeString(entry.directory);
        if (!normalizedDirectory) {
          this.loggerProvider()?.warn('assiant.directory_map.invalid_entry', {
            filePath,
            assiantId,
            entryType: 'object',
            isLegacyFlatString: false,
            hasValidAssiantId: true,
            hasDirectory: 'directory' in entry,
            directoryType: typeof entry.directory,
          });
          continue;
        }
        mapping.set(normalizedAssiantId, normalizedDirectory);
      }

      this.loggerProvider()?.info('assiant.directory_map.loaded', {
        filePath,
        entryCount: mapping.size,
      });
      return mapping;
    } catch (error) {
      this.loggerProvider()?.warn('assiant.directory_map.load_failed', {
        filePath,
        error: getErrorMessage(error),
        ...getErrorDetailsForLog(error),
      });
      return new Map();
    }
  }
}
