import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateTransfer } from '../server/journey/transferEngine';

const time = (minutes: number) => new Date(Date.UTC(2026, 8, 30, 8, minutes));

describe('Journey transfer feasibility', () => {
  it('rejects a two-minute connection when schedule uncertainty and buffer are considered', () => {
    const result = evaluateTransfer({
      predictedArrivalAt: time(0), etaUncertaintySeconds: 8 * 60,
      nextDepartureAt: time(2), walkingSeconds: 60, minimumTransferBufferSeconds: 5 * 60,
    });
    assert.equal(result.feasible, false);
    assert.equal(result.risk, 'CRITICAL');
    assert.equal(result.connectionWindowStart.toISOString(), '2026-09-30T07:52:00.000Z');
  });

  it('keeps uncertainty inside the future pickup/boarding window', () => {
    const result = evaluateTransfer({
      predictedArrivalAt: time(0), etaUncertaintySeconds: 8 * 60,
      nextDepartureAt: time(40), walkingSeconds: 2 * 60, minimumTransferBufferSeconds: 5 * 60,
      boardingGraceSeconds: 3 * 60,
    });
    assert.equal(result.feasible, true);
    assert.equal(result.risk, 'LOW');
    assert.equal(result.connectionWindowStart.getTime(), time(0).getTime() - 8 * 60_000);
    assert.equal(result.connectionWindowEnd.getTime(), time(0).getTime() + 13 * 60_000);
  });

  it('accepts the exact feasible boundary and rejects a departure one second earlier', () => {
    const predictedArrivalAt = time(0);
    const requiredSeconds = 2 * 60 + 60 + 5 * 60 + 3 * 60;
    const exact = evaluateTransfer({
      predictedArrivalAt, etaUncertaintySeconds: 2 * 60,
      nextDepartureAt: new Date(predictedArrivalAt.getTime() + requiredSeconds * 1000),
      walkingSeconds: 60, minimumTransferBufferSeconds: 5 * 60, boardingGraceSeconds: 3 * 60,
    });
    const oneSecondShort = evaluateTransfer({
      predictedArrivalAt, etaUncertaintySeconds: 2 * 60,
      nextDepartureAt: new Date(predictedArrivalAt.getTime() + (requiredSeconds - 1) * 1000),
      walkingSeconds: 60, minimumTransferBufferSeconds: 5 * 60, boardingGraceSeconds: 3 * 60,
    });

    assert.equal(exact.requiredSeconds, requiredSeconds);
    assert.equal(exact.slackSeconds, 0);
    assert.equal(exact.feasible, true);
    assert.equal(oneSecondShort.slackSeconds, -1);
    assert.equal(oneSecondShort.feasible, false);
  });

  it('rejects invalid uncertainty and negative transfer components', () => {
    assert.throws(() => evaluateTransfer({
      predictedArrivalAt: time(0), etaUncertaintySeconds: -1,
      nextDepartureAt: time(10), walkingSeconds: 0, minimumTransferBufferSeconds: 0,
    }), /valid non-negative seconds/);
  });
});
