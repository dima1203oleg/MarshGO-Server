import crypto from 'node:crypto';

export type PasswordValidation = {
  valid: boolean;
  reason?: string;
};

export type EmailValidation = {
  valid: boolean;
  normalized?: string;
  reason?: string;
};

const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validateEmail(email: unknown): EmailValidation {
  if (typeof email !== 'string') {
    return { valid: false, reason: 'Електронна пошта обов’язкова' };
  }
  const trimmed = email.trim();
  if (trimmed.length < 5 || trimmed.length > 254) {
    return { valid: false, reason: 'Довжина пошти має бути від 5 до 254 символів' };
  }
  if (!EMAIL_REGEX.test(trimmed)) {
    return { valid: false, reason: 'Некоректний формат електронної пошти' };
  }
  return { valid: true, normalized: trimmed.toLowerCase() };
}

export function validatePassword(password: unknown): PasswordValidation {
  if (typeof password !== 'string') {
    return { valid: false, reason: 'Пароль обов’язковий' };
  }
  if (password.length < 8) {
    return { valid: false, reason: 'Пароль має містити щонайменше 8 символів' };
  }
  if (password.length > 128) {
    return { valid: false, reason: 'Пароль занадто довгий (максимум 128 символів)' };
  }
  if (!/[a-zA-Z\u0400-\u04FF]/.test(password)) {
    return { valid: false, reason: 'Пароль має містити хоча б одну літеру' };
  }
  if (!/[0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(password)) {
    return { valid: false, reason: 'Пароль має містити хоча б одну цифру або спеціальний символ' };
  }
  return { valid: true };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`scrypt$16384$8$1$${salt}$${derivedKey.toString('hex')}`);
    });
  });
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = parseInt(parts[1], 10);
  const r = parseInt(parts[2], 10);
  const p = parseInt(parts[3], 10);
  const salt = parts[4];
  const keyHex = parts[5];
  if (!N || !r || !p || !salt || !keyHex) return false;
  const expectedKey = Buffer.from(keyHex, 'hex');

  return new Promise((resolve) => {
    crypto.scrypt(password, salt, expectedKey.length, { N, r, p }, (err, derivedKey) => {
      if (err) return resolve(false);
      try {
        resolve(crypto.timingSafeEqual(expectedKey, derivedKey));
      } catch {
        resolve(false);
      }
    });
  });
}

export function generateResetToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, tokenHash };
}
