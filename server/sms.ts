export type SmsDelivery = { provider: 'development'; testCode: string } | { provider: 'twilio' } | { provider: 'getotp' };

export class SmsProviderUnavailableError extends Error {
  constructor() { super('SMS provider is not configured'); }
}

export async function sendVerificationCode(phone: string, code: string): Promise<SmsDelivery> {
  if (process.env.NODE_ENV === 'development' && (process.env.AUTH_DEV_OTP === 'true' || process.env.SMS_PROVIDER === 'development')) {
    // No network call is made by this adapter. The code is returned only to the local developer.
    return { provider: 'development', testCode: code };
  }

  if (process.env.SMS_PROVIDER === 'getotp') {
    const apiKey = process.env.GETOTP_API_KEY;
    if (!apiKey) throw new SmsProviderUnavailableError();

    // Using a typical structure for getotp.co API, assuming they take api_key, phone, and otp.
    // Replace the URL and payload if their actual API docs differ.
    const response = await fetch('https://getotp.co/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        channel: 'whatsapp',
        phone: phone,
        otp: code,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`GetOtp API returned ${response.status}`);
    return { provider: 'getotp' };
  } else if (process.env.SMS_PROVIDER === 'twilio') {
    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = process.env;
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) throw new SmsProviderUnavailableError();

    const credentials = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    const form = new URLSearchParams({ To: phone, From: TWILIO_FROM_NUMBER, Body: `MARSHGO verification code: ${code}` });
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`SMS provider returned ${response.status}`);
    return { provider: 'twilio' };
  }

  throw new SmsProviderUnavailableError();
}
