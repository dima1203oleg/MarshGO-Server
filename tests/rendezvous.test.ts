import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getRendezvousSettings, isWithinPickupGeofence, rendezvousActivationAt, resolveRendezvousAction } from '../server/rendezvous';

describe('Rendezvous status and geofence rules', () => {
  it('requires both participants to confirm before marking them nearby', () => {
    const driver = resolveRendezvousAction('driver', 'arrived', 'ACTIVE');
    assert.equal(driver.state, 'DRIVER_WAITING');
    const passenger = resolveRendezvousAction('passenger', 'arrived', driver.state);
    assert.equal(passenger.state, 'BOTH_NEARBY');
    assert.equal(passenger.arrivalField, 'passenger_arrived_at');
  });

  it('reports an approaching participant without clearing the other participant state', () => {
    assert.equal(resolveRendezvousAction('passenger', 'approaching', 'DRIVER_WAITING').state, 'PASSENGER_APPROACHING');
    assert.equal(resolveRendezvousAction('driver', 'delayed', 'PASSENGER_WAITING').state, 'PASSENGER_WAITING');
  });

  it('does not let an arrived participant regress back to approaching', () => {
    assert.throws(() => resolveRendezvousAction('driver', 'approaching', 'DRIVER_WAITING'));
    assert.throws(() => resolveRendezvousAction('passenger', 'delayed', 'BOTH_NEARBY'));
  });

  it('does not infer arrival when GPS accuracy is too poor or outside the conservative radius', () => {
    assert.equal(isWithinPickupGeofence(20, 30, 75), true);
    assert.equal(isWithinPickupGeofence(60, 30, 75), false);
    assert.equal(isWithinPickupGeofence(1, 250, 75), false);
  });

  it('activates sharing 15 minutes before the scheduled pickup', () => {
    const pickup = new Date('2026-10-01T08:00:00Z');
    assert.equal(rendezvousActivationAt(pickup).toISOString(), '2026-10-01T07:45:00.000Z');
    assert.throws(() => rendezvousActivationAt(pickup, 0), /activation lead/);
  });

  it('loads bounded geofence and activation settings from the server environment', () => {
    assert.deepEqual(getRendezvousSettings({}), { geofenceMeters: 75, leadMinutes: 15 });
    assert.deepEqual(getRendezvousSettings({ RENDEZVOUS_GEOFENCE_METERS: '90', RENDEZVOUS_LEAD_MINUTES: '20' }), { geofenceMeters: 90, leadMinutes: 20 });
    assert.throws(() => getRendezvousSettings({ RENDEZVOUS_GEOFENCE_METERS: '250' }));
    assert.throws(() => getRendezvousSettings({ RENDEZVOUS_LEAD_MINUTES: '0' }));
  });

  it('rejects actions after boarding or a terminal transition', () => {
    assert.throws(() => resolveRendezvousAction('passenger', 'arrived', 'BOARDING'), /no longer accepting/);
    assert.throws(() => resolveRendezvousAction('driver', 'delayed', 'CANCELLED'), /no longer accepting/);
  });
});
