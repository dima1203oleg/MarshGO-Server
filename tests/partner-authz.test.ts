import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canPerformOrganizationOperations, canReadOrganizationMembership } from '../server/partner/authz';

describe('partner organization authorization rules', () => {
  it('allows only an active membership to read a non-rejected organization', () => {
    assert.equal(canReadOrganizationMembership({ membershipStatus: 'ACTIVE', organizationStatus: 'PENDING_REVIEW' }), true);
    assert.equal(canReadOrganizationMembership({ membershipStatus: 'INVITED', organizationStatus: 'ACTIVE' }), false);
    assert.equal(canReadOrganizationMembership({ membershipStatus: 'SUSPENDED', organizationStatus: 'ACTIVE' }), false);
    assert.equal(canReadOrganizationMembership({ membershipStatus: 'ACTIVE', organizationStatus: 'REJECTED' }), false);
  });

  it('denies every organization operation before approval or after suspension', () => {
    assert.equal(canPerformOrganizationOperations({ membershipStatus: 'ACTIVE', organizationStatus: 'PENDING_REVIEW', role: 'organization_owner' }), false);
    assert.equal(canPerformOrganizationOperations({ membershipStatus: 'ACTIVE', organizationStatus: 'SUSPENDED', role: 'organization_owner' }), false);
    assert.equal(canPerformOrganizationOperations({ membershipStatus: 'SUSPENDED', organizationStatus: 'ACTIVE', role: 'organization_owner' }), false);
  });

  it('enforces organization-scoped roles for each operation', () => {
    const activeDispatcher = { membershipStatus: 'ACTIVE', organizationStatus: 'ACTIVE' as const, role: 'dispatcher' };
    assert.equal(canPerformOrganizationOperations({ ...activeDispatcher, requiredRoles: ['dispatcher','organization_admin'] }), true);
    assert.equal(canPerformOrganizationOperations({ ...activeDispatcher, requiredRoles: ['finance_manager'] }), false);
    assert.equal(canPerformOrganizationOperations({ membershipStatus: 'ACTIVE', organizationStatus: 'ACTIVE', role: 'unknown', requiredRoles: ['organization_owner'] }), false);
  });
});
