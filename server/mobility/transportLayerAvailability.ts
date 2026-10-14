export type TransportLayerAvailabilityInput = {
  lines: ReadonlySet<string>;
  micro: ReadonlySet<string>;
  stationsAvailable: boolean;
};

/** Reports whether a map layer has validated data behind it; unsupported modes stay unavailable. */
export function buildTransportLayerAvailability({ lines, micro, stationsAvailable }: TransportLayerAvailabilityInput) {
  const publicTransport = ['bus', 'marshrutka', 'trolleybus', 'tram'].some((type) => lines.has(type));
  return [
    { id: 'PUBLIC_TRANSPORT', available: publicTransport },
    { id: 'BUS', available: lines.has('bus') },
    { id: 'MINIBUS', available: lines.has('marshrutka') },
    { id: 'TROLLEYBUS', available: lines.has('trolleybus') },
    { id: 'TRAM', available: lines.has('tram') },
    { id: 'METRO', available: lines.has('metro') },
    { id: 'TRAIN', available: lines.has('train') || lines.has('suburban') || lines.has('city_train') },
    { id: 'CITY_TRAIN', available: lines.has('city_train') },
    { id: 'FUNICULAR', available: lines.has('funicular') },
    { id: 'CARPOOL', available: false },
    { id: 'TAXI', available: false },
    { id: 'TRANSFER', available: false },
    { id: 'BICYCLE', available: micro.has('bike') || micro.has('ebike') },
    { id: 'SCOOTER', available: micro.has('scooter') },
    { id: 'CARSHARING', available: micro.has('carsharing') },
    { id: 'STOPS', available: publicTransport || lines.has('train') || lines.has('suburban') || lines.has('metro') },
    { id: 'RENTAL_POINTS', available: stationsAvailable },
  ];
}
