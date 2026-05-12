export class InstallCliError extends Error {
  readonly code: string;
  readonly details?: string;

  constructor(code: string, message: string, details?: string) {
    super(message);
    this.name = "InstallCliError";
    this.code = code;
    this.details = details;
  }
}

export function toInstallCliError(error: unknown, fallbackCode = "INSTALL_FAILED"): InstallCliError {
  if (error instanceof InstallCliError) {
    return error;
  }
  if (error instanceof Error) {
    return new InstallCliError(fallbackCode, error.message);
  }
  return new InstallCliError(fallbackCode, String(error));
}
