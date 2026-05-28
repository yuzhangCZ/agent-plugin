import type { ProviderCommandError } from "@wecode/bridge-runtime-sdk";

export function createProviderCommandError(
  code: ProviderCommandError["code"],
  message: string,
  details?: Record<string, unknown>,
): Error & ProviderCommandError {
  const error = new Error(message) as Error & ProviderCommandError;
  error.name = "ProviderCommandError";
  error.code = code;
  error.details = details;
  return error;
}
