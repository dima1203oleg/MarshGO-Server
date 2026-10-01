const maximumAuthorizationLength = 96;
const accessTokenLength = 43;

export function parseBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader || authorizationHeader.length > maximumAuthorizationLength) return undefined;

  let separator = -1;
  for (let index = 0; index < authorizationHeader.length; index += 1) {
    const code = authorizationHeader.charCodeAt(index);
    if (code === 32 || code === 9) {
      separator = index;
      break;
    }
  }
  if (separator < 1 || authorizationHeader.slice(0, separator).toLowerCase() !== 'bearer') return undefined;

  const token = authorizationHeader.slice(separator).trim();
  if (token.length !== accessTokenLength) return undefined;
  for (let index = 0; index < token.length; index += 1) {
    const code = token.charCodeAt(index);
    const isUppercase = code >= 65 && code <= 90;
    const isLowercase = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (!isUppercase && !isLowercase && !isDigit && code !== 45 && code !== 95) return undefined;
  }
  return token;
}
