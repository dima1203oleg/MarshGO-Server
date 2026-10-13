/** Phones that receive the admin role after a verified sign-in. Configured server-side only (ADMIN_PHONES, comma-separated E.164). */
export function configuredAdminPhones(environment: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((environment.ADMIN_PHONES ?? '').split(',').map((phone) => phone.trim()).filter((phone) => /^\+[1-9]\d{7,14}$/.test(phone)));
}

/** The development OTP is shown in the UI, so the phone is not proof of ownership there: never grant admin in that mode. */
export function adminGrantAllowed(environment: NodeJS.ProcessEnv = process.env): boolean {
  const devOtpVisible = environment.NODE_ENV === 'development' && (environment.AUTH_DEV_OTP === 'true' || environment.SMS_PROVIDER === 'development');
  return !devOtpVisible;
}

export function shouldGrantAdmin(phone: string, environment: NodeJS.ProcessEnv = process.env): boolean {
  return adminGrantAllowed(environment) && configuredAdminPhones(environment).has(phone);
}
