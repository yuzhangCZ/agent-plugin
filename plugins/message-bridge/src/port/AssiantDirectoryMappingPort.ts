export interface AssiantDirectoryMappingPort {
  resolveDirectory(assiantId: string): Promise<string | undefined>;
}

