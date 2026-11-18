type PasswordResetEnvironment = { NODE_ENV?: string; AUTH_EXPOSE_RESET_TOKEN?: string };

/** Token issuance is permitted only in isolated tests that explicitly need to inspect the token. */
export function passwordResetTestModeEnabled(environment: PasswordResetEnvironment = process.env): boolean {
  return environment.NODE_ENV === 'test' && environment.AUTH_EXPOSE_RESET_TOKEN === 'true';
}
