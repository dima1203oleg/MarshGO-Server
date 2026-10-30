export const PARTNER_ROLES = [
  'organization_owner',
  'organization_admin',
  'dispatcher',
  'fleet_manager',
  'finance_manager',
  'technical_manager',
  'viewer',
] as const;

export type PartnerRole = typeof PARTNER_ROLES[number];
export type OrganizationStatus = 'PENDING_REVIEW' | 'ACTIVE' | 'SUSPENDED' | 'REJECTED';

export function canReadOrganizationMembership(input: {
  membershipStatus: string;
  organizationStatus: OrganizationStatus;
}) {
  return input.membershipStatus === 'ACTIVE' && input.organizationStatus !== 'REJECTED';
}

export function canPerformOrganizationOperations(input: {
  membershipStatus: string;
  organizationStatus: OrganizationStatus;
  role: string;
  requiredRoles?: readonly PartnerRole[];
}) {
  if (input.membershipStatus !== 'ACTIVE' || input.organizationStatus !== 'ACTIVE') return false;
  return !input.requiredRoles?.length || input.requiredRoles.includes(input.role as PartnerRole);
}
