/**
 * A public URL or a free-form license label does not establish commercial
 * reuse. Preserve unknown terms as null rather than upgrading them on a
 * successful health probe.
 */
export function commercialUseFromLicense(license: string | null | undefined): boolean | null {
  if (!license?.trim()) return null;
  const value = license.trim().replaceAll('_', ' ').toLocaleLowerCase('en');
  if (/\bnon[ -]?commercial\b|\bcc[ -]?by[ -]?nc(?:[ -]?(?:sa|nd))?\b/.test(value)) return false;
  if (/\bcommercial use permitted\b/.test(value)) return true;
  if (/\bcc[ -]?0\b|\bcc[ -]?by(?:[ -]?(?:sa|nd))?(?:\s*\d(?:\.\d)?)?\b/.test(value)) return true;
  if (/\bodbl\b|open database license|\bodc[ -]?by\b|open data commons attribution license|\bpddl\b/.test(value)) return true;
  return null;
}
