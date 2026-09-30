type RuntimeEnvironment = NodeJS.ProcessEnv;

function requireValue(environment: RuntimeEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required in production`);
  return value;
}

function validateProductionOrigins(value: string): void {
  const origins = value.split(',').map((origin) => origin.trim());
  if (origins.length === 0 || origins.some((origin) => !origin || origin === '*')) {
    throw new Error('CORS_ORIGINS must contain explicit production origins');
  }
  for (const origin of origins) {
    if (origin === 'capacitor://localhost') continue;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error('CORS_ORIGINS contains an invalid origin');
    }
    const allowed = parsed.protocol === 'https:'
      || (parsed.protocol === 'capacitor:' && parsed.hostname === 'localhost');
    if (!allowed || parsed.origin !== origin || parsed.username || parsed.password) {
      throw new Error('CORS_ORIGINS must use HTTPS web origins or capacitor://localhost');
    }
  }
}

/** Fail closed before listening if production could silently use dev auth or default CORS. */
export function validateRuntimeConfig(environment: RuntimeEnvironment): void {
  if (environment.NODE_ENV !== 'production') return;

  const secret = requireValue(environment, 'SESSION_SECRET');
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 bytes in production');
  }
  if (environment.AUTH_DEV_BYPASS === 'true' || environment.AUTH_DEV_OTP === 'true') {
    throw new Error('development authentication is forbidden in production');
  }

  validateProductionOrigins(requireValue(environment, 'CORS_ORIGINS'));

  if (environment.SMS_PROVIDER !== 'twilio') {
    throw new Error('SMS_PROVIDER=twilio is required in production');
  }
  requireValue(environment, 'TWILIO_ACCOUNT_SID');
  requireValue(environment, 'TWILIO_AUTH_TOKEN');
  requireValue(environment, 'TWILIO_FROM_NUMBER');
}
