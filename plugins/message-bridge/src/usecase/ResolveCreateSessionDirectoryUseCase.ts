import type { AssiantDirectoryMappingPort } from '../port/AssiantDirectoryMappingPort.js';
import type { BridgeChannelPort } from '../port/BridgeChannelPort.js';
import type { BridgeLogger } from '../types/logger.js';

export interface ResolveCreateSessionDirectoryInput {
  assistantId?: string;
  effectiveDirectory?: string;
  mappingConfigured?: boolean;
}

export interface ResolvedCreateSessionDirectory {
  directory?: string;
  source: 'mapping' | 'effective' | 'none';
}

type DirectoryUnresolvedReason =
  | 'mapping_file_unconfigured'
  | 'missing_assiant_id'
  | 'directory_unresolved';

export class ResolveCreateSessionDirectoryUseCase {
  constructor(
    private readonly bridgeChannelPort: BridgeChannelPort,
    private readonly directoryMappingPort: AssiantDirectoryMappingPort,
    private readonly logger?: BridgeLogger,
  ) {}

  async execute(input: ResolveCreateSessionDirectoryInput): Promise<ResolvedCreateSessionDirectory> {
    if (this.bridgeChannelPort.isAssiantChannel()) {
      if (!input.mappingConfigured) {
        this.warnUnresolved('mapping_file_unconfigured', input);
        return this.resolveFallback(input);
      }

      if (!input.assistantId) {
        this.warnUnresolved('missing_assiant_id', input);
        return this.resolveFallback(input);
      }

      const mappedDirectory = await this.directoryMappingPort.resolveDirectory(input.assistantId);
      if (mappedDirectory) {
        return {
          directory: mappedDirectory,
          source: 'mapping',
        };
      }

      this.warnUnresolved('directory_unresolved', input);
    }

    return this.resolveFallback(input);
  }

  private resolveFallback(input: ResolveCreateSessionDirectoryInput): ResolvedCreateSessionDirectory {
    if (input.effectiveDirectory) {
      return {
        directory: input.effectiveDirectory,
        source: 'effective',
      };
    }

    return {
      source: 'none',
    };
  }

  private warnUnresolved(reason: DirectoryUnresolvedReason, input: ResolveCreateSessionDirectoryInput): void {
    const fallback = this.resolveFallback(input);
    this.logger?.warn('assiant.directory_map.unresolved', {
      reason,
      channel: this.bridgeChannelPort.getChannel(),
      assistantId: input.assistantId,
      mappingConfigured: Boolean(input.mappingConfigured),
      hasEffectiveDirectory: Boolean(input.effectiveDirectory),
      fallbackSource: fallback.source,
    });
  }
}
