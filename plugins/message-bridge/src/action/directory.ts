function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function attachDirectory<T extends Record<string, unknown>>(parameters: T, effectiveDirectory?: string): T & { directory?: string } {
  if (!effectiveDirectory) {
    return parameters;
  }
  return {
    ...parameters,
    directory: effectiveDirectory,
  };
}

export function attachDirectoryQuery<T extends Record<string, unknown>>(parameters: T, effectiveDirectory?: string): T {
  if (!effectiveDirectory) {
    return parameters;
  }

  const query = isRecord(parameters.query) ? parameters.query : {};
  return {
    ...parameters,
    query: {
      ...query,
      directory: effectiveDirectory,
    },
  };
}
