/**
 * A public URL or a free-form license label does not establish commercial
 * reuse. Preserve unknown terms as null rather than upgrading them on a
 * successful health probe.
 */
export function commercialUseFromLicense(license: string | null | undefined): boolean | null {
  if (!license?.trim()) return null;
  const value = license.trim().replaceAll('_', ' ').toLocaleLowerCase('en');
  if (/\bnon[ -]?commercial\b|\bcc[ -]?by[ -]?nc(?:[ -]?(?:sa|nd))?\b/.test(value)) return false;
  // OwnNet's source-available license bars paid hosted/SaaS distribution
  // without separate written consent. Ignore stale catalog annotations that
  // claim the opposite after the actual license name.
  if (/\bownnet source license\b/.test(value)) return false;
  if (/\bcommercial use permitted\b/.test(value)) return true;
  if (/\bcreative commons attribution(?:\s+[0-9]+(?:\.[0-9]+)?)?(?:\s+international)?\b/.test(value)) return true;
  if (/\bcc[ -]?0\b|\bcc[ -]?by(?:[ -]?(?:sa|nd))?(?:\s*\d(?:\.\d)?)?\b/.test(value)) return true;
  if (/\bodbl\b|open database license|\bodc[ -]?by\b|open data commons attribution license|\bpddl\b/.test(value)) return true;
  return null;
}

/** A provider feed may be enabled only when commercial reuse is explicitly allowed. */
export function hasVerifiedCommercialFeedRights(license: string | null | undefined): boolean {
  return commercialUseFromLicense(license) === true;
}
