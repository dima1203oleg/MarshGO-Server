import { haversineMeters, planKyivRapidTransitJourneys, KYIV_METRO_STATIONS } from '../mobility/kyivTransitGraph';
import { generatePedestrianGeometry } from '../../shared/navigation/pedestrianGeometry';
import { getRoadRoute } from '../routing';
import type { JourneyStrategy, JourneyPreferences, JourneyLegMode } from './types';
import type { GtfsItinerary } from './gtfsTimetable';
import { scoreJourneys } from './scoring';

export interface MultimodalLeg {
  id?: string;
  ordinal: number;
  mode: JourneyLegMode;
  origin: { name: string; coordinates: [number, number] };
  destination: { name: string; coordinates: [number, number] };
  departureAt: Date;
  arrivalAt: Date;
  durationSeconds: number;
  distanceMeters: number;
  walkingDistanceMeters?: number;
  priceMinor: number | null;
  currency: string;
  priceStatus: 'LOCKED' | 'ESTIMATED' | 'DYNAMIC' | 'UNKNOWN';
  availabilityStatus: 'AVAILABLE' | 'UNKNOWN';
  providerId?: string;
  providerType: string;
  providerName?: string;
  routeName?: string;
  headsign?: string;
  offerId?: string | null;
  driver?: { id: string; name: string; averageRating: number | null; reviewCount: number } | null;
  vehicle?: { id?: string; make?: string; model?: string } | null;
  state: 'SUGGESTED' | 'SELECTED';
  source: string;
  stops?: Array<{
    id: string;
    name: string;
    coordinates?: [number, number];
    departureAt?: string;
    arrivalAt?: string;
  }>;
  routeGeometry?: Array<[number, number]>;
  metadata?: Record<string, unknown>;
}

export interface MultimodalJourney {
  id: string;
  strategy: JourneyStrategy;
  score: number;
  state: 'PLANNED';
  source: string;
  providerName?: string;
  offerId?: string | null;
  totalDurationSeconds: number;
  totalPriceMinor: number | null;
  confirmedPriceMinor: number | null;
  estimatedPriceMinMinor: number | null;
  estimatedPriceMaxMinor: number | null;
  walkingMeters: number;
  transfers: number;
  reliabilityScore: number | null;
  comfortScore: number | null;
  legs: MultimodalLeg[];
}

export interface MultimodalChainInput {
  origin: { name: string; coordinates: [number, number] };
  destination: { name: string; coordinates: [number, number] };
  departureAt: Date;
  passengers: number;
  strategy: JourneyStrategy;
  preferences: JourneyPreferences;
  gtfsItineraries?: GtfsItinerary[];
  communityOffers?: Array<{
    offer_id: string;
    driver_id: string;
    driver_name: string;
    vehicle_id: string;
    origin_name: string;
    destination_name: string;
    origin_lon: number;
    origin_lat: number;
    destination_lon: number;
    destination_lat: number;
    departure_at: Date;
    arrival_at: Date | null;
    duration_s: number;
    distance_m: number;
    price_per_seat_minor: number;
    currency: string;
    available_seats: number;
    average_rating: number | null;
    review_count: number;
    vehicle_make: string;
    vehicle_model: string;
  }>;
}

export interface MultimodalChainDependencies {
  getRoadRoute: typeof getRoadRoute;
}

/**
 * Builds multimodal journey chains combining:
 * - Walking (Пішки)
 * - Metro (Київський метрополітен — Червона, Синя, Зелена лінії)
 * - City Express (Кільцева електричка УЗ)
 * - Funicular (Київський фунікулер)
 * - Municipal Bus, Tram, Trolleybus, Marshrutka (Київпастранс)
 * - Road-route estimates for taxi legs (provider quote/availability remain unknown)
 * - Carpool (MARSHGO Community offers)
 */
export async function composeKyivMultimodalChains(
  input: MultimodalChainInput,
  dependencies: MultimodalChainDependencies = { getRoadRoute },
): Promise<MultimodalJourney[]> {
  const { origin, destination, departureAt, passengers, strategy, preferences } = input;
  const allowed = preferences.allowedTransportTypes;
  const isTypeAllowed = (type: string) => !allowed || allowed.includes(type as any);

  const journeys: MultimodalJourney[] = [];
  const originCoord = origin.coordinates;
  const destCoord = destination.coordinates;
  const getRoadRouteForJourney = dependencies.getRoadRoute;

  const totalDirectDistance = haversineMeters(originCoord, destCoord);

  // 1. DIRECT RAPID TRANSIT (Metro, City Express, Funicular)
  const rapidTransitOptions = planKyivRapidTransitJourneys(originCoord, destCoord, 3000);

  for (const rapid of rapidTransitOptions) {
    if (!rapid.segments.every((s) => isTypeAllowed(s.transportType))) continue;

    const legs: MultimodalLeg[] = [];
    let currentDeparture = new Date(departureAt);
    let ordinal = 0;

    // First leg: Walk to origin station
    if (rapid.distanceToOriginStationMeters > 50) {
      const walkDur = Math.ceil(rapid.distanceToOriginStationMeters / 1.25);
      const walkArrival = new Date(currentDeparture.getTime() + walkDur * 1000);
      legs.push({
        ordinal,
        mode: 'WALK',
        origin,
        destination: { name: `ст. м. ${rapid.originStation.name}`, coordinates: rapid.originStation.coordinates },
        departureAt: new Date(currentDeparture),
        arrivalAt: walkArrival,
        durationSeconds: walkDur,
        distanceMeters: rapid.distanceToOriginStationMeters,
        walkingDistanceMeters: rapid.distanceToOriginStationMeters,
        priceMinor: 0,
        currency: 'UAH',
        priceStatus: 'LOCKED',
        availabilityStatus: 'AVAILABLE',
        providerType: 'walking',
        state: 'SUGGESTED',
        source: 'walking',
        routeGeometry: generatePedestrianGeometry(origin.coordinates, rapid.originStation.coordinates),
        metadata: { title: `Пішки до ст. ${rapid.originStation.name}` },
      });
      currentDeparture = walkArrival;
    }

    // Transit segments
    for (let i = 0; i < rapid.segments.length; i++) {
      const seg = rapid.segments[i];

      // If transfer before segment
      if (i > 0 && rapid.transferWalkingSeconds[i - 1]) {
        const transDur = rapid.transferWalkingSeconds[i - 1];
        const transDist = rapid.transferWalkingMeters[i - 1] ?? 150;
        const transArrival = new Date(currentDeparture.getTime() + transDur * 1000);
        const fromCoord = legs.at(-1)!.destination.coordinates;
        legs.push({
          ordinal: ordinal++,
          mode: 'WALK',
          origin: { name: legs.at(-1)!.destination.name, coordinates: fromCoord },
          destination: { name: `ст. ${seg.originStation.name}`, coordinates: seg.originStation.coordinates },
          departureAt: new Date(currentDeparture),
          arrivalAt: transArrival,
          durationSeconds: transDur,
          distanceMeters: transDist,
          walkingDistanceMeters: transDist,
          priceMinor: 0,
          currency: 'UAH',
          priceStatus: 'LOCKED',
          availabilityStatus: 'AVAILABLE',
          providerType: 'walking',
          state: 'SUGGESTED',
          source: 'transfer-walk',
          routeGeometry: generatePedestrianGeometry(fromCoord, seg.originStation.coordinates),
          metadata: { title: 'Пересадка між лініями' },
        });
        currentDeparture = transArrival;
      }

      const segArrival = new Date(currentDeparture.getTime() + seg.durationSeconds * 1000);
      const segStations = [seg.originStation, ...(seg.intermediateStations ?? []), seg.destinationStation];
      const segStops = segStations.map(s => ({ id: s.id, name: s.name, coordinates: s.coordinates }));
      const segCoords = segStations.map(s => s.coordinates);

      legs.push({
        ordinal: ordinal++,
        mode: seg.mode,
        origin: { name: `ст. ${seg.originStation.name}`, coordinates: seg.originStation.coordinates },
        destination: { name: `ст. ${seg.destinationStation.name}`, coordinates: seg.destinationStation.coordinates },
        departureAt: new Date(currentDeparture),
        arrivalAt: segArrival,
        durationSeconds: seg.durationSeconds,
        distanceMeters: seg.distanceMeters,
        priceMinor: seg.fareMinor,
        currency: 'UAH',
        priceStatus: 'LOCKED',
        availabilityStatus: 'AVAILABLE',
        providerId: seg.providerId,
        providerType: 'public_transit',
        providerName: seg.providerName,
        routeName: seg.lineName,
        headsign: seg.destinationStation.name,
        state: 'SUGGESTED',
        source: 'kyiv-open-data',
        stops: segStops,
        routeGeometry: segCoords,
        metadata: {
          transportType: seg.transportType,
          intermediateStopsCount: seg.intermediateStations.length,
          stops: segStops,
        },
      });
      currentDeparture = segArrival;
    }

    // Last leg: Walk from final station to destination
    if (rapid.distanceFromDestinationStationMeters > 50) {
      const walkDur = Math.ceil(rapid.distanceFromDestinationStationMeters / 1.25);
      const walkArrival = new Date(currentDeparture.getTime() + walkDur * 1000);
      legs.push({
        ordinal,
        mode: 'WALK',
        origin: { name: `ст. ${rapid.destinationStation.name}`, coordinates: rapid.destinationStation.coordinates },
        destination,
        departureAt: new Date(currentDeparture),
        arrivalAt: walkArrival,
        durationSeconds: walkDur,
        distanceMeters: rapid.distanceFromDestinationStationMeters,
        walkingDistanceMeters: rapid.distanceFromDestinationStationMeters,
        priceMinor: 0,
        currency: 'UAH',
        priceStatus: 'LOCKED',
        availabilityStatus: 'AVAILABLE',
        providerType: 'walking',
        state: 'SUGGESTED',
        source: 'walking',
        routeGeometry: generatePedestrianGeometry(rapid.destinationStation.coordinates, destination.coordinates),
        metadata: { title: `Пішки до місця призначення` },
      });
      currentDeparture = walkArrival;
    }

    const totalDur = Math.round((currentDeparture.getTime() - departureAt.getTime()) / 1000);
    const totalWalking = legs.filter((l) => l.mode === 'WALK').reduce((sum, l) => sum + l.distanceMeters, 0);

    journeys.push({
      id: `kyiv-transit:${rapid.id}`,
      strategy,
      score: totalDur + rapid.totalFareMinor * 0.2,
      state: 'PLANNED',
      source: 'kyiv-open-data',
      providerName: rapid.segments[0].providerName,
      totalDurationSeconds: totalDur,
      totalPriceMinor: rapid.totalFareMinor,
      confirmedPriceMinor: rapid.totalFareMinor,
      estimatedPriceMinMinor: rapid.totalFareMinor,
      estimatedPriceMaxMinor: rapid.totalFareMinor,
      walkingMeters: totalWalking,
      transfers: rapid.transfers,
      reliabilityScore: 0.95, // Metro on-time reliability
      comfortScore: 0.85,
      legs,
    });
  }

  // Rental bikes and scooters are planned only from live GBFS assets in the search handler.
  // A road path is an estimate, not a provider quote or a confirmed taxi.
  // Keep it useful for route geometry while leaving price and availability unknown.
  if (isTypeAllowed('taxi')) {
    try {
      const roadRoute = await getRoadRouteForJourney(originCoord, destCoord);
      const arrivalAt = new Date(departureAt.getTime() + roadRoute.durationSeconds * 1000);

      journeys.push({
        id: `taxi:direct:${Math.round(roadRoute.distanceMeters)}`,
        strategy,
        score: roadRoute.durationSeconds,
        state: 'PLANNED',
        source: 'road-route-estimate',
        providerName: 'Орієнтовний маршрут таксі',
        totalDurationSeconds: roadRoute.durationSeconds,
        totalPriceMinor: null,
        confirmedPriceMinor: null,
        estimatedPriceMinMinor: null,
        estimatedPriceMaxMinor: null,
        walkingMeters: 0,
        transfers: 0,
        reliabilityScore: null,
        comfortScore: null,
        legs: [
          {
            ordinal: 0,
            mode: 'TAXI',
            origin,
            destination,
            departureAt: new Date(departureAt),
            arrivalAt,
            durationSeconds: roadRoute.durationSeconds,
            distanceMeters: Math.round(roadRoute.distanceMeters),
            priceMinor: null,
            currency: 'UAH',
            priceStatus: 'UNKNOWN',
            availabilityStatus: 'UNKNOWN',
            providerType: 'taxi',
            providerName: 'Орієнтовний маршрут таксі',
            state: 'SUGGESTED',
            source: 'road-route-estimate',
            routeGeometry: roadRoute.geometry,
            metadata: {
              roadDistanceKm: (roadRoute.distanceMeters / 1000).toFixed(1),
              durationStatus: 'ESTIMATED',
              routeAccuracy: 'SOURCE_ROAD_GEOMETRY',
              providerQuote: false,
            },
          },
        ],
      });
    } catch {
      // Without road geometry, do not invent a direct taxi route or arrival time.
    }
  }

  // 4. MULTIMODAL CHAIN: TAXI -> RAPID TRANSIT / TRAIN -> WALK
  if (isTypeAllowed('taxi') && isTypeAllowed('metro') && totalDirectDistance > 8000) {
    const centralStations = KYIV_METRO_STATIONS.filter((st) => ['Вокзальна', 'Видубичі', 'Деміївська', 'Почайна'].includes(st.name));
    for (const hub of centralStations) {
      const hubJourneys = planKyivRapidTransitJourneys(hub.coordinates, destCoord, 2000);
      if (hubJourneys.length > 0) {
        const rapidLeg = hubJourneys[0];
        const distToHub = haversineMeters(originCoord, hub.coordinates);
        if (distToHub >= 3000) {
          let taxiRoadRoute: Awaited<ReturnType<typeof getRoadRoute>>;
          try {
            taxiRoadRoute = await getRoadRouteForJourney(originCoord, hub.coordinates);
          } catch {
            continue;
          }

          const legs: MultimodalLeg[] = [];
          let curTime = new Date(departureAt);

          // Leg 1: Taxi to central hub
          const taxiArr = new Date(curTime.getTime() + taxiRoadRoute.durationSeconds * 1000);
          legs.push({
            ordinal: legs.length,
            mode: 'TAXI',
            origin,
            destination: { name: `Вокзал / ст. ${hub.name}`, coordinates: hub.coordinates },
            departureAt: new Date(curTime),
            arrivalAt: taxiArr,
            durationSeconds: taxiRoadRoute.durationSeconds,
            distanceMeters: taxiRoadRoute.distanceMeters,
            priceMinor: null,
            currency: 'UAH',
            priceStatus: 'UNKNOWN',
            availabilityStatus: 'UNKNOWN',
            providerType: 'taxi',
            providerName: 'Орієнтовний маршрут таксі',
            state: 'SUGGESTED',
            source: 'road-route-estimate',
            routeGeometry: taxiRoadRoute.geometry,
            metadata: { durationStatus: 'ESTIMATED', routeAccuracy: 'SOURCE_ROAD_GEOMETRY', providerQuote: false },
          });
          curTime = new Date(taxiArr.getTime() + 180_000); // 3 min entry buffer

          // Leg 2..N: Rapid transit
          for (let i = 0; i < rapidLeg.segments.length; i++) {
            const seg = rapidLeg.segments[i];

            // If transfer between rapid transit segments
            if (i > 0 && rapidLeg.transferWalkingSeconds && rapidLeg.transferWalkingSeconds[i - 1]) {
              const transDur = rapidLeg.transferWalkingSeconds[i - 1];
              const transDist = rapidLeg.transferWalkingMeters?.[i - 1] ?? 150;
              const transArr = new Date(curTime.getTime() + transDur * 1000);
              legs.push({
                ordinal: legs.length,
                mode: 'WALK',
                origin: { name: legs.at(-1)!.destination.name, coordinates: legs.at(-1)!.destination.coordinates },
                destination: { name: `ст. ${seg.originStation.name}`, coordinates: seg.originStation.coordinates },
                departureAt: new Date(curTime),
                arrivalAt: transArr,
                durationSeconds: transDur,
                distanceMeters: transDist,
                walkingDistanceMeters: transDist,
                priceMinor: 0,
                currency: 'UAH',
                priceStatus: 'LOCKED',
                availabilityStatus: 'AVAILABLE',
                providerType: 'walking',
                state: 'SUGGESTED',
                source: 'transfer-walk',
                metadata: { title: 'Пересадка між лініями' },
              });
              curTime = transArr;
            }

            const segArr = new Date(curTime.getTime() + seg.durationSeconds * 1000);
            legs.push({
              ordinal: legs.length,
              mode: seg.mode,
              origin: { name: `ст. ${seg.originStation.name}`, coordinates: seg.originStation.coordinates },
              destination: { name: `ст. ${seg.destinationStation.name}`, coordinates: seg.destinationStation.coordinates },
              departureAt: new Date(curTime),
              arrivalAt: segArr,
              durationSeconds: seg.durationSeconds,
              distanceMeters: seg.distanceMeters,
              priceMinor: seg.fareMinor,
              currency: 'UAH',
              priceStatus: 'LOCKED',
              availabilityStatus: 'AVAILABLE',
              providerId: seg.providerId,
              providerType: 'public_transit',
              providerName: seg.providerName,
              routeName: seg.lineName,
              state: 'SUGGESTED',
              source: 'kyiv-open-data',
            });
            curTime = segArr;
          }

          // Walk to dest
          if (rapidLeg.distanceFromDestinationStationMeters > 50) {
            const walkDur = Math.ceil(rapidLeg.distanceFromDestinationStationMeters / 1.25);
            const walkArr = new Date(curTime.getTime() + walkDur * 1000);
            legs.push({
              ordinal: legs.length,
              mode: 'WALK',
              origin: { name: `ст. ${rapidLeg.destinationStation.name}`, coordinates: rapidLeg.destinationStation.coordinates },
              destination,
              departureAt: new Date(curTime),
              arrivalAt: walkArr,
              durationSeconds: walkDur,
              distanceMeters: rapidLeg.distanceFromDestinationStationMeters,
              walkingDistanceMeters: rapidLeg.distanceFromDestinationStationMeters,
              priceMinor: 0,
              currency: 'UAH',
              priceStatus: 'LOCKED',
              availabilityStatus: 'AVAILABLE',
              providerType: 'walking',
              state: 'SUGGESTED',
              source: 'walking',
            });
            curTime = walkArr;
          }

          const totalDur = Math.round((curTime.getTime() - departureAt.getTime()) / 1000);
          const totalPrice = null;

          journeys.push({
            id: `chain:taxi-metro:${hub.id}-${rapidLeg.destinationStation.id}`,
            strategy,
            score: totalDur,
            state: 'PLANNED',
            source: 'multimodal-chain',
            providerName: `Орієнтовний маршрут таксі + ${rapidLeg.segments[0].providerName}`,
            totalDurationSeconds: totalDur,
            totalPriceMinor: totalPrice,
            confirmedPriceMinor: null,
            estimatedPriceMinMinor: null,
            estimatedPriceMaxMinor: null,
            walkingMeters: rapidLeg.distanceFromDestinationStationMeters,
            transfers: rapidLeg.transfers + 1,
            reliabilityScore: null,
            comfortScore: null,
            legs,
          });
          break; // Keep best hub option
        }
      }
    }
  }

  // Intercity rail is supplied only by eligible dated GTFS/API candidates in the journey search.
  // Do not turn the static corridor catalog into invented departures, fares, stops or geometry.

  // 5. DIRECT COMMUNITY CARPOOL (from database offers)
  if (input.communityOffers && isTypeAllowed('carpool')) {
    for (const offer of input.communityOffers) {
      const arrAt = offer.arrival_at ?? new Date(offer.departure_at.getTime() + offer.duration_s * 1000);
      const totalFare = offer.price_per_seat_minor * passengers;
      journeys.push({
        id: `community:${offer.offer_id}`,
        strategy,
        score: offer.duration_s + totalFare * 0.2,
        state: 'PLANNED',
        source: 'community-offer',
        providerName: 'MARSHGO Community',
        offerId: offer.offer_id,
        totalDurationSeconds: offer.duration_s,
        totalPriceMinor: totalFare,
        confirmedPriceMinor: null,
        estimatedPriceMinMinor: totalFare,
        estimatedPriceMaxMinor: totalFare,
        walkingMeters: 0,
        transfers: 0,
        reliabilityScore: 0.90,
        comfortScore: 0.88,
        legs: [
          {
            ordinal: 0,
            mode: 'COMMUNITY',
            origin: { name: offer.origin_name, coordinates: [offer.origin_lon, offer.origin_lat] },
            destination: { name: offer.destination_name, coordinates: [offer.destination_lon, offer.destination_lat] },
            departureAt: offer.departure_at,
            arrivalAt: arrAt,
            durationSeconds: offer.duration_s,
            distanceMeters: offer.distance_m,
            priceMinor: totalFare,
            currency: offer.currency,
            priceStatus: 'ESTIMATED',
            availabilityStatus: 'AVAILABLE',
            providerType: 'community',
            offerId: offer.offer_id,
            state: 'SUGGESTED',
            source: 'community-offer',
            driver: {
              id: offer.driver_id,
              name: offer.driver_name,
              averageRating: offer.average_rating ? Number(offer.average_rating) : null,
              reviewCount: offer.review_count,
            },
            vehicle: {
              id: offer.vehicle_id,
              make: offer.vehicle_make,
              model: offer.vehicle_model,
            },
          },
        ],
      });
    }
  }

  // Rank and score based on strategy using scoring.ts
  const journeyOptions = journeys.map((j) => ({
    id: j.id,
    durationSeconds: j.totalDurationSeconds,
    priceMinor: j.totalPriceMinor,
    transfers: j.transfers,
    walkingMeters: j.walkingMeters,
    reliability: j.reliabilityScore,
    transferRisk: j.legs.length > 1 ? Math.min((j.legs.length - 1) * 0.1, 1) : 0,
    comfort: j.comfortScore,
    legs: j.legs.map((leg) => ({ mode: leg.mode, providerId: leg.providerId })),
    _originalJourney: j,
  }));

  const scoredOptions = scoreJourneys(journeyOptions, strategy);

  const scored = scoredOptions.map((so) => ({
    ...so.journey._originalJourney,
    score: so.score,
  }));

  // Eliminate duplicates by ID
  const seen = new Set<string>();
  const uniqueJourneys: MultimodalJourney[] = [];
  for (const j of scored) {
    if (!seen.has(j.id)) {
      seen.add(j.id);
      // Guarantee sequential 0-based ordinals for all legs in the chain
      j.legs.forEach((leg, index) => {
        leg.ordinal = index;
      });
      uniqueJourneys.push(j);
    }
  }

  return uniqueJourneys.slice(0, 25);
}

export const composeUkraineMultimodalChains = composeKyivMultimodalChains;
