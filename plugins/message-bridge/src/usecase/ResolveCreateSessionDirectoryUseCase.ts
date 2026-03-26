import type { AssiantDirectoryMappingPort } from '../port/AssiantDirectoryMappingPort.js';
import type { BridgeChannelPort } from '../port/BridgeChannelPort.js';

export interface ResolveCreateSessionDirectoryInput {
  assiantId?: string;
  effectiveDirectory?: string;
}

export interface ResolvedCreateSessionDirectory {
  directory?: string;
  source: 'mapping' | 'effective' | 'none';
}

export class ResolveCreateSessionDirectoryUseCase {
  constructor(
    private readonly bridgeChannelPort: BridgeChannelPort,
    private readonly directoryMappingPort: AssiantDirectoryMappingPort,
  ) {}

  async execute(input: ResolveCreateSessionDirectoryInput): Promise<ResolvedCreateSessionDirectory> {
    if (this.bridgeChannelPort.isAssiantChannel() && input.assiantId) {
      const mappedDirectory = await this.directoryMappingPort.resolveDirectory(input.assiantId);
      if (mappedDirectory) {
        return {
          directory: mappedDirectory,
          source: 'mapping',
        };
      }
    }

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
}

