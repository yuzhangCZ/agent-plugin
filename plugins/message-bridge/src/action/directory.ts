export function attachDirectory<T extends Record<string, unknown>>(parameters: T, effectiveDirectory?: string): T & { directory?: string } {
  if (!effectiveDirectory) {
    return parameters;
  }
  return {
    ...parameters,
    directory: effectiveDirectory,
  };
}
