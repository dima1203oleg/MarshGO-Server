import { haversineMeters, planKyivRapidTransitJourneys, KYIV_METRO_STATIONS, findStationsWithinRadius } from '../mobility/kyivTransitGraph';
import {
  planCityTransitJourneys,
  findUkraineStationsWithinRadius,
  UKRAINE_REGIONAL_HUBS,
  INTERCITY_CORRIDORS,
  getCorridorTrackGeometry,
} from '../mobility/ukraineTransitGraph';
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
  availabilityStatus: 'AVAILABLE';
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

// Kyiv Taxi Fare calculation based on official Kyiv market rates (Uklon / Bolt / Uber)
export function calculateKyivTaxiEstimate(distanceMeters: number, durationSeconds: number) {
  const km = distanceMeters / 1000;
  const minutes = durationSeconds / 60;
  // Base 60 UAH + 12 UAH/km + 2 UAH/min, minimum 85 UAH
  const fareUah = Math.max(85, 60 + km * 12 + minutes * 2);
  const fareMinor = Math.round(fareUah * 100);
  return {
    fareMinor,
    currency: 'UAH',
    priceStatus: 'ESTIMATED' as const,
  };
}

// Kyiv Micromobility fare calculation (Zelectra / Bolt scooters: 10 UAH unlock + 3.80 UAH/min)
export function calculateScooterEstimate(durationSeconds: number) {
  const minutes = Math.ceil(durationSeconds / 60);
  const fareUah = 10 + minutes * 3.8;
  return Math.round(fareUah * 100);
}

// Kyiv Bike sharing fare calculation (Bikenow: 5 UAH unlock + 1.50 UAH/min)
export function calculateBikeEstimate(durationSeconds: number) {
  const minutes = Math.ceil(durationSeconds / 60);
  const fareUah = 5 + minutes * 1.5;
  return Math.round(fareUah * 100);
}

/**
 * Builds multimodal journey chains combining:
 * - Walking (Пішки)
 * - Micromobility: E-scooters & Bikes (Zelectra, Bikenow)
 * - Metro (Київський метрополітен — Червона, Синя, Зелена лінії)
 * - City Express (Кільцева електричка УЗ)
 * - Funicular (Київський фунікулер)
 * - Municipal Bus, Tram, Trolleybus, Marshrutka (Київпастранс)
 * - Taxi / Ride-hail (Uklon, Bolt, Uber)
 * - Carpool (MARSHGO Community offers)
 */
export async function composeKyivMultimodalChains(input: MultimodalChainInput): Promise<MultimodalJourney[]> {
  const { origin, destination, departureAt, passengers, strategy, preferences } = input;
  const allowed = preferences.allowedTransportTypes;
  const isTypeAllowed = (type: string) => !allowed || allowed.includes(type as any);

  const journeys: MultimodalJourney[] = [];
  const originCoord = origin.coordinates;
  const destCoord = destination.coordinates;

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

  // 1b. REGIONAL INTRA-CITY TRANSIT (Lviv Trams, Odesa Trams, Kharkiv Metro, Dnipro Metro & Trams)
  if (totalDirectDistance < 40_000) {
    const regionalCities: Array<'Львів' | 'Одеса' | 'Харків' | 'Дніпро'> = ['Львів', 'Одеса', 'Харків', 'Дніпро'];
    for (const city of regionalCities) {
      const cityItineraries = planCityTransitJourneys(city, originCoord, destCoord, 3500);
      for (const item of cityItineraries) {
        if (!item.segments.every((s) => isTypeAllowed(s.transportType))) continue;

        const legs: MultimodalLeg[] = [];
        let currentDeparture = new Date(departureAt);

        // Walk to origin station
        if (item.distanceToOriginStationMeters > 50) {
          const walkDur = Math.ceil(item.distanceToOriginStationMeters / 1.25);
          const walkArrival = new Date(currentDeparture.getTime() + walkDur * 1000);
          legs.push({
            ordinal: legs.length,
            mode: 'WALK',
            origin,
            destination: { name: `ст. ${item.originStation.name}`, coordinates: item.originStation.coordinates },
            departureAt: new Date(currentDeparture),
            arrivalAt: walkArrival,
            durationSeconds: walkDur,
            distanceMeters: item.distanceToOriginStationMeters,
            walkingDistanceMeters: item.distanceToOriginStationMeters,
            priceMinor: 0,
            currency: 'UAH',
            priceStatus: 'LOCKED',
            availabilityStatus: 'AVAILABLE',
            providerType: 'walking',
            state: 'SUGGESTED',
            source: 'walking',
            metadata: { title: `Пішки до зупинки ${item.originStation.name}` },
          });
          currentDeparture = walkArrival;
        }

        // Transit segment
        for (let i = 0; i < item.segments.length; i++) {
          const seg = item.segments[i];

          // If transfer before segment
          if (i > 0 && item.transferWalkingSeconds && item.transferWalkingSeconds[i - 1]) {
            const transDur = item.transferWalkingSeconds[i - 1];
            const transDist = item.transferWalkingMeters?.[i - 1] ?? 120;
            const transArrival = new Date(currentDeparture.getTime() + transDur * 1000);
            legs.push({
              ordinal: legs.length,
              mode: 'WALK',
              origin: { name: legs.at(-1)!.destination.name, coordinates: legs.at(-1)!.destination.coordinates },
              destination: { name: seg.originStation.name, coordinates: seg.originStation.coordinates },
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
              metadata: { title: 'Пересадка між лініями' },
            });
            currentDeparture = transArrival;
          }

          const segArrival = new Date(currentDeparture.getTime() + seg.durationSeconds * 1000);
          legs.push({
            ordinal: legs.length,
            mode: seg.mode,
            origin: { name: seg.originStation.name, coordinates: seg.originStation.coordinates },
            destination: { name: seg.destinationStation.name, coordinates: seg.destinationStation.coordinates },
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
            source: 'ukraine-city-data',
            metadata: { transportType: seg.transportType },
          });
          currentDeparture = segArrival;
        }

        // Walk from final station to destination
        if (item.distanceFromDestinationStationMeters > 50) {
          const walkDur = Math.ceil(item.distanceFromDestinationStationMeters / 1.25);
          const walkArrival = new Date(currentDeparture.getTime() + walkDur * 1000);
          legs.push({
            ordinal: legs.length,
            mode: 'WALK',
            origin: { name: `ст. ${item.destinationStation.name}`, coordinates: item.destinationStation.coordinates },
            destination,
            departureAt: new Date(currentDeparture),
            arrivalAt: walkArrival,
            durationSeconds: walkDur,
            distanceMeters: item.distanceFromDestinationStationMeters,
            walkingDistanceMeters: item.distanceFromDestinationStationMeters,
            priceMinor: 0,
            currency: 'UAH',
            priceStatus: 'LOCKED',
            availabilityStatus: 'AVAILABLE',
            providerType: 'walking',
            state: 'SUGGESTED',
            source: 'walking',
            metadata: { title: 'Пішки до пункту призначення' },
          });
          currentDeparture = walkArrival;
        }

        const totalDur = Math.round((currentDeparture.getTime() - departureAt.getTime()) / 1000);
        const totalWalking = legs.filter((l) => l.mode === 'WALK').reduce((sum, l) => sum + l.distanceMeters, 0);

        journeys.push({
          id: `regional-transit:${item.id}`,
          strategy,
          score: totalDur + item.totalFareMinor * 0.2,
          state: 'PLANNED',
          source: 'ukraine-city-data',
          providerName: item.segments[0].providerName,
          totalDurationSeconds: totalDur,
          totalPriceMinor: item.totalFareMinor,
          confirmedPriceMinor: item.totalFareMinor,
          estimatedPriceMinMinor: item.totalFareMinor,
          estimatedPriceMaxMinor: item.totalFareMinor,
          walkingMeters: totalWalking,
          transfers: item.transfers,
          reliabilityScore: 0.94,
          comfortScore: 0.88,
          legs,
        });
      }
    }
  }

  // 2. MULTIMODAL CHAIN: SCOOTER / BIKE -> METRO -> WALK
  if (isTypeAllowed('scooter') || isTypeAllowed('bike')) {
    const isScooter = isTypeAllowed('scooter');
    const micromobilityMode: JourneyLegMode = isScooter ? 'SCOOTER' : 'BICYCLE';
    const providerName = isScooter ? 'Zelectra (Електросамокати)' : 'Bikenow (Велопрокат)';
    const speedMps = isScooter ? 4.16 : 3.33; // 15 km/h vs 12 km/h

    // Find stations within 1.5 - 4.5 km of origin
    const reachableMetro = findStationsWithinRadius(originCoord, KYIV_METRO_STATIONS, 4500)
      .filter((st) => st.distanceMeters >= 700);

    if (reachableMetro.length > 0 && rapidTransitOptions.length > 0) {
      const matching = reachableMetro.map((st) => {
        const journeys = planKyivRapidTransitJourneys(st.station.coordinates, destCoord, 300)
          .filter((j) => j.originStation.id === st.station.id);
        return { station: st, journey: journeys[0] };
      }).filter((m) => Boolean(m.journey));

      if (matching.length > 0) {
        const { station: bestStation, journey: rapidPart } = matching[0];
        const rideDurationSeconds = Math.round(bestStation.distanceMeters / speedMps);
        const rideFareMinor = isScooter
          ? calculateScooterEstimate(rideDurationSeconds)
          : calculateBikeEstimate(rideDurationSeconds);

        const legs: MultimodalLeg[] = [];
        let curTime = new Date(departureAt);
        let ordinal = 0;

        // Leg 1: Scooter/Bike ride to station
        const rideArrival = new Date(curTime.getTime() + rideDurationSeconds * 1000);
        legs.push({
          ordinal: ordinal++,
          mode: micromobilityMode,
          origin,
          destination: { name: `ст. м. ${bestStation.station.name}`, coordinates: bestStation.station.coordinates },
          departureAt: new Date(curTime),
          arrivalAt: rideArrival,
          durationSeconds: rideDurationSeconds,
          distanceMeters: bestStation.distanceMeters,
          priceMinor: rideFareMinor,
          currency: 'UAH',
          priceStatus: 'ESTIMATED',
          availabilityStatus: 'AVAILABLE',
          providerType: 'micromobility',
          providerName,
          state: 'SUGGESTED',
          source: 'gbfs-zelectra',
          metadata: {
            transportType: isScooter ? 'scooter' : 'bike',
            title: `Поїздка на ${isScooter ? 'електросамокаті' : 'велосипеді'} до метро`,
          },
        });
        curTime = new Date(rideArrival.getTime() + 120_000); // 2 min parking & entry buffer

        // Leg 2..N: Rapid transit segments
        for (let i = 0; i < rapidPart.segments.length; i++) {
          const seg = rapidPart.segments[i];

          // If transfer between rapid transit segments
          if (i > 0 && rapidPart.transferWalkingSeconds && rapidPart.transferWalkingSeconds[i - 1]) {
            const transDur = rapidPart.transferWalkingSeconds[i - 1];
            const transDist = rapidPart.transferWalkingMeters?.[i - 1] ?? 150;
            const transArrival = new Date(curTime.getTime() + transDur * 1000);
            legs.push({
              ordinal: legs.length,
              mode: 'WALK',
              origin: { name: legs.at(-1)!.destination.name, coordinates: legs.at(-1)!.destination.coordinates },
              destination: { name: `ст. ${seg.originStation.name}`, coordinates: seg.originStation.coordinates },
              departureAt: new Date(curTime),
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
              metadata: { title: 'Пересадка між лініями' },
            });
            curTime = transArrival;
          }

          const segArrival = new Date(curTime.getTime() + seg.durationSeconds * 1000);
          legs.push({
            ordinal: legs.length,
            mode: seg.mode,
            origin: { name: `ст. ${seg.originStation.name}`, coordinates: seg.originStation.coordinates },
            destination: { name: `ст. ${seg.destinationStation.name}`, coordinates: seg.destinationStation.coordinates },
            departureAt: new Date(curTime),
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
          });
          curTime = segArrival;
        }

        // Final walk
        if (rapidPart.distanceFromDestinationStationMeters > 50) {
          const walkDur = Math.ceil(rapidPart.distanceFromDestinationStationMeters / 1.25);
          const walkArr = new Date(curTime.getTime() + walkDur * 1000);
          legs.push({
            ordinal,
            mode: 'WALK',
            origin: { name: `ст. ${rapidPart.destinationStation.name}`, coordinates: rapidPart.destinationStation.coordinates },
            destination,
            departureAt: new Date(curTime),
            arrivalAt: walkArr,
            durationSeconds: walkDur,
            distanceMeters: rapidPart.distanceFromDestinationStationMeters,
            walkingDistanceMeters: rapidPart.distanceFromDestinationStationMeters,
            priceMinor: 0,
            currency: 'UAH',
            priceStatus: 'LOCKED',
            availabilityStatus: 'AVAILABLE',
            providerType: 'walking',
            state: 'SUGGESTED',
            source: 'walking',
            metadata: { title: 'Пішки від метро' },
          });
          curTime = walkArr;
        }

        const totalDur = Math.round((curTime.getTime() - departureAt.getTime()) / 1000);
        const totalPrice = rideFareMinor + rapidPart.totalFareMinor;
        const totalWalk = legs.filter((l) => l.mode === 'WALK').reduce((sum, l) => sum + l.distanceMeters, 0);

        journeys.push({
          id: `chain:${isScooter ? 'scooter' : 'bike'}-metro:${bestStation.station.id}-${rapidPart.destinationStation.id}`,
          strategy,
          score: totalDur + totalPrice * 0.15,
          state: 'PLANNED',
          source: 'multimodal-chain',
          providerName: `${providerName} + Київський метрополітен`,
          totalDurationSeconds: totalDur,
          totalPriceMinor: totalPrice,
          confirmedPriceMinor: null,
          estimatedPriceMinMinor: totalPrice,
          estimatedPriceMaxMinor: totalPrice,
          walkingMeters: totalWalk,
          transfers: rapidPart.transfers + 1,
          reliabilityScore: 0.92,
          comfortScore: 0.90,
          legs,
        });
      }
    }
  }

  // 2b. DIRECT MICROMOBILITY: E-SCOOTER & BIKE (within urban radius up to 16 km)
  if (totalDirectDistance >= 500 && totalDirectDistance <= 16_000) {
    // E-Scooter (Bolt Scooters, Zelectra, e-Wings)
    if (isTypeAllowed('scooter')) {
      const roadDistMeters = Math.round(totalDirectDistance * 1.25);
      const rideDurationSeconds = Math.round(roadDistMeters / 4.16); // ~15 km/h
      const rideFareMinor = calculateScooterEstimate(rideDurationSeconds);
      const arrAt = new Date(departureAt.getTime() + rideDurationSeconds * 1000);

      journeys.push({
        id: `scooter:direct:${roadDistMeters}`,
        strategy,
        score: rideDurationSeconds * 0.7 + rideFareMinor * 0.25,
        state: 'PLANNED',
        source: 'micromobility',
        providerName: 'Bolt / Zelectra (Електросамокат)',
        totalDurationSeconds: rideDurationSeconds,
        totalPriceMinor: rideFareMinor,
        confirmedPriceMinor: null,
        estimatedPriceMinMinor: Math.round(rideFareMinor * 0.9),
        estimatedPriceMaxMinor: Math.round(rideFareMinor * 1.1),
        walkingMeters: 0,
        transfers: 0,
        reliabilityScore: 0.95,
        comfortScore: 0.85,
        legs: [
          {
            ordinal: 0,
            mode: 'SCOOTER',
            origin,
            destination,
            departureAt: new Date(departureAt),
            arrivalAt: arrAt,
            durationSeconds: rideDurationSeconds,
            distanceMeters: roadDistMeters,
            priceMinor: rideFareMinor,
            currency: 'UAH',
            priceStatus: 'ESTIMATED',
            availabilityStatus: 'AVAILABLE',
            providerType: 'micromobility',
            providerName: 'Bolt / Zelectra Scooters',
            state: 'SUGGESTED',
            source: 'micromobility',
            metadata: {
              transportType: 'scooter',
              title: 'Поїздка на електросамокаті (Bolt / Zelectra)',
              batteryPercent: 88,
              speedKmH: 15,
            },
          },
        ],
      });
    }

    // Bicycle / Bike Rental (Bikenow, Nextbike)
    if (isTypeAllowed('bike') && totalDirectDistance <= 12_000) {
      const roadDistMeters = Math.round(totalDirectDistance * 1.2);
      const rideDurationSeconds = Math.round(roadDistMeters / 3.33); // ~12 km/h
      const rideFareMinor = calculateBikeEstimate(rideDurationSeconds);
      const arrAt = new Date(departureAt.getTime() + rideDurationSeconds * 1000);

      journeys.push({
        id: `bike:direct:${roadDistMeters}`,
        strategy,
        score: rideDurationSeconds * 0.75 + rideFareMinor * 0.2,
        state: 'PLANNED',
        source: 'micromobility',
        providerName: 'Bikenow / Nextbike (Велопрокат)',
        totalDurationSeconds: rideDurationSeconds,
        totalPriceMinor: rideFareMinor,
        confirmedPriceMinor: null,
        estimatedPriceMinMinor: rideFareMinor,
        estimatedPriceMaxMinor: rideFareMinor,
        walkingMeters: 0,
        transfers: 0,
        reliabilityScore: 0.92,
        comfortScore: 0.80,
        legs: [
          {
            ordinal: 0,
            mode: 'BICYCLE',
            origin,
            destination,
            departureAt: new Date(departureAt),
            arrivalAt: arrAt,
            durationSeconds: rideDurationSeconds,
            distanceMeters: roadDistMeters,
            priceMinor: rideFareMinor,
            currency: 'UAH',
            priceStatus: 'ESTIMATED',
            availabilityStatus: 'AVAILABLE',
            providerType: 'micromobility',
            providerName: 'Bikenow / Nextbike',
            state: 'SUGGESTED',
            source: 'micromobility',
            metadata: {
              transportType: 'bike',
              title: 'Поїздка на велосипеді (Bikenow / Nextbike)',
              speedKmH: 12,
            },
          },
        ],
      });
    }
  }

  // 3. DIRECT TAXI (Uklon / Bolt / Uber)
  if (isTypeAllowed('taxi')) {
    try {
      const roadRoute = await getRoadRoute(originCoord, destCoord);
      const taxiEstimate = calculateKyivTaxiEstimate(roadRoute.distanceMeters, roadRoute.durationSeconds);
      const arrivalAt = new Date(departureAt.getTime() + roadRoute.durationSeconds * 1000);

      journeys.push({
        id: `taxi:direct:${Math.round(roadRoute.distanceMeters)}`,
        strategy,
        score: roadRoute.durationSeconds * 0.8 + taxiEstimate.fareMinor * 0.3,
        state: 'PLANNED',
        source: 'taxi',
        providerName: 'Uklon / Bolt Таксі',
        totalDurationSeconds: roadRoute.durationSeconds,
        totalPriceMinor: taxiEstimate.fareMinor,
        confirmedPriceMinor: null,
        estimatedPriceMinMinor: Math.round(taxiEstimate.fareMinor * 0.9),
        estimatedPriceMaxMinor: Math.round(taxiEstimate.fareMinor * 1.15),
        walkingMeters: 0,
        transfers: 0,
        reliabilityScore: 0.94,
        comfortScore: 0.98,
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
            priceMinor: taxiEstimate.fareMinor,
            currency: 'UAH',
            priceStatus: 'ESTIMATED',
            availabilityStatus: 'AVAILABLE',
            providerType: 'taxi',
            providerName: 'Таксі (Uklon / Bolt / Uber)',
            state: 'SUGGESTED',
            source: 'partner-taxi',
            metadata: {
              pickupMinutes: 4,
              vehicleClasses: ['Standard', 'Comfort', 'Eco'],
              roadDistanceKm: (roadRoute.distanceMeters / 1000).toFixed(1),
            },
          },
        ],
      });
    } catch {
      // Fallback taxi calculation using haversine road estimation
      const estRoadDist = Math.round(totalDirectDistance * 1.35);
      const estDur = Math.round(estRoadDist / 11); // ~40 km/h city speed
      const taxiEstimate = calculateKyivTaxiEstimate(estRoadDist, estDur);
      const arrAt = new Date(departureAt.getTime() + estDur * 1000);

      journeys.push({
        id: `taxi:direct-est:${estRoadDist}`,
        strategy,
        score: estDur * 0.8 + taxiEstimate.fareMinor * 0.3,
        state: 'PLANNED',
        source: 'taxi',
        providerName: 'Uklon / Bolt Таксі',
        totalDurationSeconds: estDur,
        totalPriceMinor: taxiEstimate.fareMinor,
        confirmedPriceMinor: null,
        estimatedPriceMinMinor: Math.round(taxiEstimate.fareMinor * 0.9),
        estimatedPriceMaxMinor: Math.round(taxiEstimate.fareMinor * 1.15),
        walkingMeters: 0,
        transfers: 0,
        reliabilityScore: 0.90,
        comfortScore: 0.95,
        legs: [
          {
            ordinal: 0,
            mode: 'TAXI',
            origin,
            destination,
            departureAt: new Date(departureAt),
            arrivalAt: arrAt,
            durationSeconds: estDur,
            distanceMeters: estRoadDist,
            priceMinor: taxiEstimate.fareMinor,
            currency: 'UAH',
            priceStatus: 'ESTIMATED',
            availabilityStatus: 'AVAILABLE',
            providerType: 'taxi',
            providerName: 'Таксі (Uklon / Bolt / Uber)',
            state: 'SUGGESTED',
            source: 'partner-taxi',
          },
        ],
      });
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
          const taxiDistance = Math.round(distToHub * 1.3);
          const taxiDuration = Math.round(taxiDistance / 12);
          const taxiFare = calculateKyivTaxiEstimate(taxiDistance, taxiDuration).fareMinor;

          const legs: MultimodalLeg[] = [];
          let curTime = new Date(departureAt);

          // Leg 1: Taxi to central hub
          const taxiArr = new Date(curTime.getTime() + taxiDuration * 1000);
          legs.push({
            ordinal: legs.length,
            mode: 'TAXI',
            origin,
            destination: { name: `Вокзал / ст. ${hub.name}`, coordinates: hub.coordinates },
            departureAt: new Date(curTime),
            arrivalAt: taxiArr,
            durationSeconds: taxiDuration,
            distanceMeters: taxiDistance,
            priceMinor: taxiFare,
            currency: 'UAH',
            priceStatus: 'ESTIMATED',
            availabilityStatus: 'AVAILABLE',
            providerType: 'taxi',
            providerName: 'Uklon / Bolt Таксі',
            state: 'SUGGESTED',
            source: 'partner-taxi',
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
          const totalPrice = taxiFare + rapidLeg.totalFareMinor;

          journeys.push({
            id: `chain:taxi-metro:${hub.id}-${rapidLeg.destinationStation.id}`,
            strategy,
            score: totalDur + totalPrice * 0.1,
            state: 'PLANNED',
            source: 'multimodal-chain',
            providerName: `Таксі + ${rapidLeg.segments[0].providerName}`,
            totalDurationSeconds: totalDur,
            totalPriceMinor: totalPrice,
            confirmedPriceMinor: null,
            estimatedPriceMinMinor: totalPrice,
            estimatedPriceMaxMinor: Math.round(totalPrice * 1.1),
            walkingMeters: rapidLeg.distanceFromDestinationStationMeters,
            transfers: rapidLeg.transfers + 1,
            reliabilityScore: 0.95,
            comfortScore: 0.94,
            legs,
          });
          break; // Keep best hub option
        }
      }
    }
  }

  // 4b. INTERCITY MULTIMODAL CORRIDORS (Укрзалізниця Intercity+, регіональні експреси та First/Last Mile)
  if (totalDirectDistance >= 25_000 && (isTypeAllowed('train') || isTypeAllowed('public_transport'))) {
    const getEligibleHubs = (point: [number, number]) => {
      const found = findUkraineStationsWithinRadius(point, UKRAINE_REGIONAL_HUBS, 80_000);
      if (found.length > 0) return found.slice(0, 3);
      return [...UKRAINE_REGIONAL_HUBS]
        .map((st) => ({
          station: st,
          distanceMeters: Math.round(haversineMeters(point, st.coordinates)),
        }))
        .sort((a, b) => a.distanceMeters - b.distanceMeters)
        .slice(0, 2);
    };

    const originHubs = getEligibleHubs(originCoord);
    const destHubs = getEligibleHubs(destCoord);

    for (const oHub of originHubs) {
      for (const dHub of destHubs) {
        if (oHub.station.id === dHub.station.id) continue;

        // 1. Direct corridor or 2. 1-stop transfer via Kyiv / Lviv
        const directCorridor = INTERCITY_CORRIDORS.find(
          (c) => c.fromHubId === oHub.station.id && c.toHubId === dHub.station.id
        );

        let corridorChain: Array<{
          corridor: (typeof INTERCITY_CORRIDORS)[number];
          fromHub: typeof oHub.station;
          toHub: typeof dHub.station;
        }> = [];

        if (directCorridor) {
          corridorChain = [{ corridor: directCorridor, fromHub: oHub.station, toHub: dHub.station }];
        } else {
          // Transfer via hub_kyiv
          const kyivHub = UKRAINE_REGIONAL_HUBS.find((h) => h.id === 'hub_kyiv')!;
          const leg1Kyiv = INTERCITY_CORRIDORS.find(
            (c) => c.fromHubId === oHub.station.id && c.toHubId === 'hub_kyiv'
          );
          const leg2Kyiv = INTERCITY_CORRIDORS.find(
            (c) => c.fromHubId === 'hub_kyiv' && c.toHubId === dHub.station.id
          );
          if (leg1Kyiv && leg2Kyiv && oHub.station.id !== 'hub_kyiv' && dHub.station.id !== 'hub_kyiv') {
            corridorChain = [
              { corridor: leg1Kyiv, fromHub: oHub.station, toHub: kyivHub },
              { corridor: leg2Kyiv, fromHub: kyivHub, toHub: dHub.station },
            ];
          } else {
            // Transfer via hub_lviv for Western Ukraine
            const lvivHub = UKRAINE_REGIONAL_HUBS.find((h) => h.id === 'hub_lviv')!;
            const leg1Lviv = INTERCITY_CORRIDORS.find(
              (c) => c.fromHubId === oHub.station.id && c.toHubId === 'hub_lviv'
            );
            const leg2Lviv = INTERCITY_CORRIDORS.find(
              (c) => c.fromHubId === 'hub_lviv' && c.toHubId === dHub.station.id
            );
            if (leg1Lviv && leg2Lviv && oHub.station.id !== 'hub_lviv' && dHub.station.id !== 'hub_lviv') {
              corridorChain = [
                { corridor: leg1Lviv, fromHub: oHub.station, toHub: lvivHub },
                { corridor: leg2Lviv, fromHub: lvivHub, toHub: dHub.station },
              ];
            }
          }
        }

        if (corridorChain.length === 0) continue;

        // Plan First Mile (Walk / City Transit / Taxi)
        const isWalkFirst = oHub.distanceMeters <= 1200;
        const firstMileTaxiDur = Math.min(1800, Math.round(oHub.distanceMeters / 11) + 240);
        const firstMileTaxiFare = Math.max(8500, Math.round((60 + (oHub.distanceMeters / 1000) * 12) * 100));

        // Check if origin city has transit to origin hub
        let firstMileTransit: { name: string; mode: JourneyLegMode; durationSeconds: number; fareMinor: number; coordinates: [number, number] } | null = null;
        if (oHub.station.city === 'Київ' && isTypeAllowed('metro') && oHub.distanceMeters > 1500 && oHub.distanceMeters < 18000) {
          const kTransit = planKyivRapidTransitJourneys(originCoord, oHub.station.coordinates, 2500);
          if (kTransit.length > 0 && kTransit[0].segments.length > 0) {
            const seg = kTransit[0].segments[0];
            firstMileTransit = {
              name: `Метро: ст. ${seg.originStation.name} → ст. ${kTransit[0].segments.at(-1)!.destinationStation.name}`,
              mode: seg.mode,
              durationSeconds: kTransit[0].totalDurationSeconds,
              fareMinor: 800 * passengers,
              coordinates: seg.originStation.coordinates,
            };
          }
        } else if (['Львів', 'Одеса', 'Харків', 'Дніпро'].includes(oHub.station.city) && oHub.distanceMeters > 1200 && oHub.distanceMeters < 12000) {
          const cityTransit = planCityTransitJourneys(oHub.station.city as any, originCoord, oHub.station.coordinates, 2500);
          if (cityTransit.length > 0 && cityTransit[0].segments.length > 0) {
            const seg = cityTransit[0].segments[0];
            firstMileTransit = {
              name: `${seg.transportType === 'tram' ? 'Трамвай' : 'Метро'}: ${seg.originStation.name} → ${cityTransit[0].segments.at(-1)!.destinationStation.name}`,
              mode: seg.mode,
              durationSeconds: cityTransit[0].totalDurationSeconds,
              fareMinor: (oHub.station.city === 'Львів' ? 1000 : 800) * passengers,
              coordinates: seg.originStation.coordinates,
            };
          }
        }

        // Plan Last Mile (Walk / City Transit / Taxi)
        const isWalkLast = dHub.distanceMeters <= 1200;
        const lastMileTaxiDur = Math.min(1800, Math.round(dHub.distanceMeters / 11) + 240);
        const lastMileTaxiFare = Math.max(8500, Math.round((60 + (dHub.distanceMeters / 1000) * 12) * 100));

        // Check if destination city has transit from destination hub
        let lastMileTransit: { name: string; mode: JourneyLegMode; durationSeconds: number; fareMinor: number; coordinates: [number, number] } | null = null;
        if (dHub.station.city === 'Київ' && isTypeAllowed('metro') && dHub.distanceMeters > 1500 && dHub.distanceMeters < 18000) {
          const kTransit = planKyivRapidTransitJourneys(dHub.station.coordinates, destCoord, 2500);
          if (kTransit.length > 0 && kTransit[0].segments.length > 0) {
            const seg = kTransit[0].segments[0];
            lastMileTransit = {
              name: `Метро: ст. ${seg.originStation.name} → ст. ${kTransit[0].segments.at(-1)!.destinationStation.name}`,
              mode: seg.mode,
              durationSeconds: kTransit[0].totalDurationSeconds,
              fareMinor: 800 * passengers,
              coordinates: kTransit[0].segments.at(-1)!.destinationStation.coordinates,
            };
          }
        } else if (['Львів', 'Одеса', 'Харків', 'Дніпро'].includes(dHub.station.city) && dHub.distanceMeters > 1200 && dHub.distanceMeters < 12000) {
          const cityTransit = planCityTransitJourneys(dHub.station.city as any, dHub.station.coordinates, destCoord, 2500);
          if (cityTransit.length > 0 && cityTransit[0].segments.length > 0) {
            const seg = cityTransit[0].segments[0];
            lastMileTransit = {
              name: `${seg.transportType === 'tram' ? 'Трамвай' : 'Метро'}: ${seg.originStation.name} → ${cityTransit[0].segments.at(-1)!.destinationStation.name}`,
              mode: seg.mode,
              durationSeconds: cityTransit[0].totalDurationSeconds,
              fareMinor: (dHub.station.city === 'Львів' ? 1000 : 800) * passengers,
              coordinates: cityTransit[0].segments.at(-1)!.destinationStation.coordinates,
            };
          }
        }

        // Generate combinations: 1) Transit/Walk-based, 2) Taxi-based
        const firstMileVariants = [
          ...(isWalkFirst
            ? [{ type: 'WALK' as const, dur: Math.ceil(oHub.distanceMeters / 1.25), fare: 0, title: `Пішки до ${oHub.station.name}` }]
            : firstMileTransit
            ? [{ type: 'TRANSIT' as const, dur: firstMileTransit.durationSeconds, fare: firstMileTransit.fareMinor, title: firstMileTransit.name }]
            : []),
          ...(!isWalkFirst && isTypeAllowed('taxi')
            ? [{ type: 'TAXI' as const, dur: firstMileTaxiDur, fare: firstMileTaxiFare, title: `Таксі до ${oHub.station.name}` }]
            : []),
        ];

        const lastMileVariants = [
          ...(isWalkLast
            ? [{ type: 'WALK' as const, dur: Math.ceil(dHub.distanceMeters / 1.25), fare: 0, title: `Пішки від ${dHub.station.name}` }]
            : lastMileTransit
            ? [{ type: 'TRANSIT' as const, dur: lastMileTransit.durationSeconds, fare: lastMileTransit.fareMinor, title: lastMileTransit.name }]
            : []),
          ...(!isWalkLast && isTypeAllowed('taxi')
            ? [{ type: 'TAXI' as const, dur: lastMileTaxiDur, fare: lastMileTaxiFare, title: `Таксі від ${dHub.station.name}` }]
            : []),
        ];

        for (const fm of firstMileVariants.slice(0, 2)) {
          for (const lm of lastMileVariants.slice(0, 2)) {
            const legs: MultimodalLeg[] = [];
            let curTime = new Date(departureAt);
            let ordinal = 0;

            // Leg 1: First Mile
            const fmArrival = new Date(curTime.getTime() + fm.dur * 1000);
            const fmGeometry = fm.type === 'WALK'
              ? generatePedestrianGeometry(origin.coordinates, oHub.station.coordinates)
              : [origin.coordinates, oHub.station.coordinates];
            legs.push({
              ordinal: ordinal++,
              mode: fm.type === 'TAXI' ? 'TAXI' : fm.type === 'TRANSIT' ? (firstMileTransit?.mode ?? 'TRAM') : 'WALK',
              origin,
              destination: { name: oHub.station.name, coordinates: oHub.station.coordinates },
              departureAt: new Date(curTime),
              arrivalAt: fmArrival,
              durationSeconds: Math.round(fm.dur),
              distanceMeters: Math.round(oHub.distanceMeters),
              walkingDistanceMeters: fm.type === 'WALK' ? Math.round(oHub.distanceMeters) : 0,
              priceMinor: Math.round(fm.fare),
              currency: 'UAH',
              priceStatus: fm.type === 'WALK' ? 'LOCKED' : fm.type === 'TRANSIT' ? 'LOCKED' : 'ESTIMATED',
              availabilityStatus: 'AVAILABLE',
              providerType: fm.type === 'TAXI' ? 'taxi' : fm.type === 'TRANSIT' ? 'public_transit' : 'walking',
              providerName: fm.type === 'TAXI' ? 'Uklon / Таксі' : fm.type === 'TRANSIT' ? 'Міський транспорт' : undefined,
              state: 'SUGGESTED',
              source: fm.type === 'TAXI' ? 'partner-taxi' : fm.type === 'TRANSIT' ? 'city-transit' : 'walking',
              routeGeometry: fmGeometry,
              metadata: { title: fm.title },
            });

            // 15-20 min buffer for station boarding
            curTime = new Date(fmArrival.getTime() + 900_000);

            // Intercity Legs (1 or 2)
            let totalRailFare = 0;
            for (let cIdx = 0; cIdx < corridorChain.length; cIdx++) {
              const item = corridorChain[cIdx];
              if (cIdx > 0) {
                // The connection buffer is time at the interchange, not a measured platform walk.
                // Keep it as a schedule gap; only add a WALK leg when a foot router/pathway graph
                // supplies connected geometry for distinct platform endpoints.
                const transferBufferSec = 1800;
                const prevArrival = legs.at(-1)!.arrivalAt;
                curTime = new Date(prevArrival.getTime() + transferBufferSec * 1000);
              }

              const legDep = new Date(curTime);
              const legArr = new Date(legDep.getTime() + item.corridor.durationSeconds * 1000);
              const legFare = item.corridor.fareMinor * passengers;
              totalRailFare += legFare;

              const corridorTrack = getCorridorTrackGeometry(
                item.fromHub.id,
                item.toHub.id,
                item.fromHub.coordinates,
                item.toHub.coordinates,
              );

              const railStops = corridorTrack.map((coord, idx) => ({
                id: `stop:${item.fromHub.id}:${idx}`,
                name: idx === 0 ? item.fromHub.name : idx === corridorTrack.length - 1 ? item.toHub.name : `ст. Проміжна (${coord[0].toFixed(2)}, ${coord[1].toFixed(2)})`,
                coordinates: coord,
                ...(idx === 0 ? { departureAt: legDep.toISOString() } : {}),
                ...(idx === corridorTrack.length - 1 ? { arrivalAt: legArr.toISOString() } : {}),
              }));

              legs.push({
                ordinal: ordinal++,
                mode: 'RAIL',
                origin: { name: item.fromHub.name, coordinates: item.fromHub.coordinates },
                destination: { name: item.toHub.name, coordinates: item.toHub.coordinates },
                departureAt: legDep,
                arrivalAt: legArr,
                durationSeconds: item.corridor.durationSeconds,
                distanceMeters: item.corridor.distanceMeters,
                priceMinor: legFare,
                currency: 'UAH',
                priceStatus: 'LOCKED',
                availabilityStatus: 'AVAILABLE',
                providerId: 'ukrzaliznytsia-intercity',
                providerType: 'rail',
                providerName: item.corridor.providerName,
                routeName: item.corridor.trainNumber,
                headsign: item.toHub.city,
                state: 'SUGGESTED',
                source: 'uz-timetable',
                stops: railStops,
                routeGeometry: corridorTrack,
                metadata: {
                  trainNumber: item.corridor.trainNumber,
                  category: item.corridor.category,
                  distanceKm: Math.round(item.corridor.distanceMeters / 1000),
                  stops: railStops,
                },
              });
              curTime = legArr;
            }

            // Last Mile
            const lastLegArrival = legs.at(-1)!.arrivalAt;
            const lmDep = new Date(lastLegArrival.getTime() + 300_000); // 5 min exit buffer
            const lmArr = new Date(lmDep.getTime() + lm.dur * 1000);
            const lmGeometry = lm.type === 'WALK'
              ? generatePedestrianGeometry(dHub.station.coordinates, destination.coordinates)
              : [dHub.station.coordinates, destination.coordinates];
            legs.push({
              ordinal,
              mode: lm.type === 'TAXI' ? 'TAXI' : lm.type === 'TRANSIT' ? (lastMileTransit?.mode ?? 'TRAM') : 'WALK',
              origin: { name: dHub.station.name, coordinates: dHub.station.coordinates },
              destination,
              departureAt: lmDep,
              arrivalAt: lmArr,
              durationSeconds: Math.round(lm.dur),
              distanceMeters: Math.round(dHub.distanceMeters),
              walkingDistanceMeters: lm.type === 'WALK' ? Math.round(dHub.distanceMeters) : 0,
              priceMinor: Math.round(lm.fare),
              currency: 'UAH',
              priceStatus: lm.type === 'WALK' ? 'LOCKED' : lm.type === 'TRANSIT' ? 'LOCKED' : 'ESTIMATED',
              availabilityStatus: 'AVAILABLE',
              providerType: lm.type === 'TAXI' ? 'taxi' : lm.type === 'TRANSIT' ? 'public_transit' : 'walking',
              providerName: lm.type === 'TAXI' ? 'Таксі від вокзалу' : lm.type === 'TRANSIT' ? 'Міський транспорт' : undefined,
              state: 'SUGGESTED',
              source: lm.type === 'TAXI' ? 'partner-taxi' : lm.type === 'TRANSIT' ? 'city-transit' : 'walking',
              routeGeometry: lmGeometry,
              metadata: { title: lm.title },
            });

            const totalChainDur = Math.round((lmArr.getTime() - departureAt.getTime()) / 1000);
            const totalChainPrice = Math.round(fm.fare + totalRailFare + lm.fare);
            const totalWalkingM = Math.round(legs.filter((l) => l.mode === 'WALK').reduce((sum, l) => sum + (l.walkingDistanceMeters ?? l.distanceMeters), 0));
            const trainNumbers = corridorChain.map((c) => c.corridor.trainNumber).join(' + ');

            journeys.push({
              id: `intercity-corridor:${trainNumbers}:${oHub.station.id}-${dHub.station.id}:${fm.type}-${lm.type}`,
              strategy,
              score: totalChainDur * 0.5 + totalChainPrice * 0.15,
              state: 'PLANNED',
              source: 'uz-multimodal-corridor',
              providerName: `${corridorChain[0].corridor.providerName} + ${fm.type === 'TRANSIT' ? 'Міський транспорт' : 'Довіз'}`,
              totalDurationSeconds: totalChainDur,
              totalPriceMinor: totalChainPrice,
              confirmedPriceMinor: null,
              estimatedPriceMinMinor: totalChainPrice,
              estimatedPriceMaxMinor: Math.round(totalChainPrice * 1.1),
              walkingMeters: totalWalkingM,
              transfers: corridorChain.length + (fm.type !== 'WALK' ? 1 : 0) + (lm.type !== 'WALK' ? 1 : 0) - 1,
              reliabilityScore: 0.96,
              comfortScore: fm.type === 'TAXI' || lm.type === 'TAXI' ? 0.95 : 0.88,
              legs,
            });
          }
        }
      }
    }
  }

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
