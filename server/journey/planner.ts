import type { ProviderOption } from '../providers/types';
import type { JourneyOption, JourneyStrategy } from './types';
import { scoreJourneys } from './scoring';
import { evaluateTransfer, type TransferEvaluation } from './transferEngine';

export interface RouteConnection {
  /** Measured by a routing provider, never inferred from straight-line distance. */
  walkingSeconds: number;
  walkingMeters: number;
  source: string;
  measuredAt: Date;
}

export interface JourneyPlanLeg extends ProviderOption {
  connectionFromPrevious: RouteConnection | null;
  transferBefore: TransferEvaluation | null;
}

export interface PlannedJourney extends JourneyOption {
  departureAt: Date;
  arrivalAt: Date;
  etaUncertaintySeconds: number;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  legs: JourneyPlanLeg[];
}

export interface JourneyPlannerInput {
  options: readonly ProviderOption[];
  originNodeId: string;
  destinationNodeId: string;
  /** Requested first departure; candidates earlier than this are rejected. */
  departureAt: Date;
  strategy: JourneyStrategy;
  /** Only include connections actually returned by a walking/routing provider. */
  connections: ReadonlyMap<string, RouteConnection>;
  minimumTransferBufferSeconds: number;
  boardingGraceSeconds?: number;
  maximumLegs?: number;
  maximumWaitSeconds?: number;
  maximumResults?: number;
}

const connectionKey = (fromNodeId: string, toNodeId: string): string => `${fromNodeId}\u0000${toNodeId}`;

export function createConnectionMap(
  pairs: readonly { fromNodeId: string; toNodeId: string; connection: RouteConnection }[],
): Map<string, RouteConnection> {
  const result = new Map<string, RouteConnection>();
  for (const pair of pairs) {
    if (!pair.fromNodeId || !pair.toNodeId
      || !Number.isInteger(pair.connection.walkingSeconds) || pair.connection.walkingSeconds < 0
      || !Number.isInteger(pair.connection.walkingMeters) || pair.connection.walkingMeters < 0
      || (pair.fromNodeId === pair.toNodeId && (pair.connection.walkingSeconds !== 0 || pair.connection.walkingMeters !== 0))
      || !pair.connection.source.trim() || !Number.isFinite(pair.connection.measuredAt.getTime())) {
      throw new TypeError('route connection must contain valid measured walking data');
    }
    result.set(connectionKey(pair.fromNodeId, pair.toNodeId), pair.connection);
  }
  return result;
}

function validateOption(option: ProviderOption): boolean {
  return Boolean(option.id && option.providerId
    && option.originNodeId && option.destinationNodeId && option.originNodeId !== option.destinationNodeId
    && option.departureAt && Number.isFinite(option.departureAt.getTime())
    && option.arrivalAt && Number.isFinite(option.arrivalAt.getTime())
    && option.arrivalAt >= option.departureAt
    && Number.isInteger(option.etaUncertaintySeconds) && option.etaUncertaintySeconds >= 0
    && (option.priceMinor === null || (Number.isSafeInteger(option.priceMinor) && option.priceMinor >= 0))
    && (option.distanceMeters === null || (Number.isInteger(option.distanceMeters) && option.distanceMeters >= 0))
    && option.availability !== 'UNAVAILABLE' && option.availability !== 'BLOCKED_EXTERNAL'
    && option.availability !== 'UNKNOWN');
}

function pathSignature(legs: readonly JourneyPlanLeg[]): string {
  return legs.map((leg) => `${leg.providerId}:${leg.id}`).join('|');
}

/**
 * Compose provider results into time-feasible journeys. This function only
 * composes inventory returned by providers; it does not create availability.
 * Transfer feasibility accounts for ETA uncertainty, measured walking time,
 * boarding grace and the configured minimum buffer.
 */
export function planJourneys(input: JourneyPlannerInput): PlannedJourney[] {
  const maximumLegs = input.maximumLegs ?? 4;
  const maximumWaitSeconds = input.maximumWaitSeconds ?? 4 * 60 * 60;
  const maximumResults = input.maximumResults ?? 30;
  const settings = [input.departureAt.getTime(), input.minimumTransferBufferSeconds, maximumLegs,
    maximumWaitSeconds, maximumResults, input.boardingGraceSeconds ?? 0];
  if (!Number.isFinite(settings[0]) || !Number.isInteger(input.minimumTransferBufferSeconds) || input.minimumTransferBufferSeconds < 0
    || !input.originNodeId || !input.destinationNodeId || input.originNodeId === input.destinationNodeId
    || !Number.isInteger(maximumLegs) || maximumLegs < 1 || maximumLegs > 8
    || !Number.isInteger(maximumWaitSeconds) || maximumWaitSeconds < 0
    || !Number.isInteger(maximumResults) || maximumResults < 1 || maximumResults > 200
    || !Number.isInteger(input.boardingGraceSeconds ?? 0) || (input.boardingGraceSeconds ?? 0) < 0) {
    throw new TypeError('journey planner bounds are invalid');
  }

  const options = input.options.filter(validateOption)
    .sort((a, b) => a.departureAt!.getTime() - b.departureAt!.getTime() || a.id.localeCompare(b.id));
  const routes: PlannedJourney[] = [];
  const maxDeparture = input.departureAt.getTime() + maximumWaitSeconds * 1000;

  const walk = (legs: JourneyPlanLeg[]): void => {
    const previous = legs.at(-1);
    if (previous && legs.length > 0) {
      const arrivalAt = previous.arrivalAt!;
      if (previous.destinationNodeId === input.destinationNodeId) {
        routes.push(summarize(legs));
        return;
      }
      if (legs.length >= maximumLegs) return;
      for (const next of options) {
        if (legs.some((leg) => leg.id === next.id) || next.departureAt!.getTime() < arrivalAt.getTime()
          || !previous.destinationNodeId || next.originNodeId !== previous.destinationNodeId) continue;
        const connection = input.connections.get(connectionKey(previous.destinationNodeId, next.originNodeId));
        if (!connection) continue;
        const wait = Math.floor((next.departureAt!.getTime() - arrivalAt.getTime()) / 1000);
        if (wait > maximumWaitSeconds) continue;
        const transferBefore = evaluateTransfer({
          predictedArrivalAt: arrivalAt,
          etaUncertaintySeconds: previous.etaUncertaintySeconds,
          nextDepartureAt: next.departureAt!,
          walkingSeconds: connection.walkingSeconds,
          minimumTransferBufferSeconds: input.minimumTransferBufferSeconds,
          boardingGraceSeconds: input.boardingGraceSeconds,
        });
        if (!transferBefore.feasible) continue;
        walk([...legs, { ...next, connectionFromPrevious: connection, transferBefore }]);
      }
    }
  };

  for (const option of options) {
    if (option.originNodeId !== input.originNodeId || option.departureAt!.getTime() < input.departureAt.getTime()
      || option.departureAt!.getTime() > maxDeparture) continue;
    walk([{ ...option, connectionFromPrevious: null, transferBefore: null }]);
  }

  const unique = [...new Map(routes.map((route) => [pathSignature(route.legs), route])).values()];
  return scoreJourneys(unique, input.strategy).slice(0, maximumResults).map(({ journey }) => journey);
}

function summarize(legs: JourneyPlanLeg[]): PlannedJourney {
  const first = legs[0];
  const last = legs.at(-1)!;
  const departureAt = first.departureAt!;
  const arrivalAt = last.arrivalAt!;
  const etaUncertaintySeconds = legs.reduce((sum, leg) => sum + leg.etaUncertaintySeconds, 0);
  const walkingMeters = legs.reduce((sum, leg) => sum + (leg.connectionFromPrevious?.walkingMeters ?? 0), 0);
  const knownPrices = legs.flatMap((leg) => leg.priceMinor === null ? [] : [leg.priceMinor]);
  const hasUnknownPrice = legs.some((leg) => leg.priceMinor === null);
  const priceMinMinor = legs.every((leg) => leg.priceMinMinor !== null)
    ? legs.reduce((sum, leg) => sum + (leg.priceMinMinor ?? 0), 0) : null;
  const priceMaxMinor = legs.every((leg) => leg.priceMaxMinor !== null)
    ? legs.reduce((sum, leg) => sum + (leg.priceMaxMinor ?? 0), 0) : null;
  const priceMinor = hasUnknownPrice ? null : knownPrices.reduce((sum, price) => sum + price, 0);
  const elapsedSeconds = Math.max(0, Math.floor((arrivalAt.getTime() - departureAt.getTime()) / 1000));
  const transferRisk = legs.slice(1).reduce((risk, leg) => Math.max(risk, riskFor(leg.transferBefore)), 0);
  const reliabilityValues = legs.map((leg) => leg.reliability).filter((value): value is number => value !== null);
  const comfortValues = legs.map((leg) => leg.comfort).filter((value): value is number => value !== null);

  return {
    id: pathSignature(legs), departureAt, arrivalAt, etaUncertaintySeconds,
    durationSeconds: elapsedSeconds,
    priceMinor, priceMinMinor, priceMaxMinor,
    transfers: Math.max(0, legs.length - 1), walkingMeters,
    reliability: reliabilityValues.length === legs.length ? Math.min(...reliabilityValues) : null,
    transferRisk, comfort: comfortValues.length === legs.length ? Math.min(...comfortValues) : null,
    legs,
  };
}

function riskFor(transfer: TransferEvaluation | null): number {
  if (!transfer) return 0;
  return transfer.risk === 'LOW' ? 0.05 : transfer.risk === 'MEDIUM' ? 0.3 : transfer.risk === 'HIGH' ? 0.7 : 1;
}
