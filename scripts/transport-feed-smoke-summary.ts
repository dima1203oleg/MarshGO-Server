export type SmokeItinerarySegment = {
  transportType: string;
};

export type SmokeItinerary = {
  segments: readonly SmokeItinerarySegment[];
};

export function summarizeSmokeItineraries(itineraries: readonly SmokeItinerary[]) {
  const modeChains = new Map<string, { modes: string[]; count: number }>();
  let multiLegCount = 0;
  let maximumLegCount = 0;

  for (const itinerary of itineraries) {
    const modes = itinerary.segments.map((segment) => segment.transportType);
    if (modes.length > 1) multiLegCount += 1;
    maximumLegCount = Math.max(maximumLegCount, modes.length);

    const key = JSON.stringify(modes);
    const existing = modeChains.get(key);
    if (existing) existing.count += 1;
    else modeChains.set(key, { modes, count: 1 });
  }

  return {
    returnedItineraryCount: itineraries.length,
    multiLegCount,
    maximumLegCount,
    modeChainCounts: [...modeChains.values()].sort((a, b) => {
      const left = a.modes.join('\u0000');
      const right = b.modes.join('\u0000');
      return left < right ? -1 : left > right ? 1 : 0;
    }),
  };
}
