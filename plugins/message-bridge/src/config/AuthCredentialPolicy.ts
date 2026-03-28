export interface AuthCredentialPolicyInput {
  bridgeGatewayChannel?: string;
  authAk?: string;
  authSk?: string;
}

export interface AuthCredentialPolicyOutput {
  shouldInjectEnvAuth: boolean;
}

export function resolveAuthCredentialPolicy(input: AuthCredentialPolicyInput): AuthCredentialPolicyOutput {
  if (input.bridgeGatewayChannel?.trim()) {
    return { shouldInjectEnvAuth: true };
  }

  const hasAuthAk = typeof input.authAk === 'string' && input.authAk.trim().length > 0;
  const hasAuthSk = typeof input.authSk === 'string' && input.authSk.trim().length > 0;

  return {
    shouldInjectEnvAuth: hasAuthAk && hasAuthSk,
  };
}
