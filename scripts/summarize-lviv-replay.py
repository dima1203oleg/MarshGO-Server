#!/usr/bin/env python3
"""Summarize serialized, paired frozen-Lviv replay JSON lines."""

import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path


records = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines() if line.strip()]
by_revision = defaultdict(list)
for record in records:
    by_revision[record["comparisonGroup"]].append(record)

expected_revisions = {"baseline", "candidate"}
if set(by_revision) != expected_revisions or any(len(items) != 3 for items in by_revision.values()):
    raise SystemExit("Expected exactly three serialized runs for baseline and candidate.")

stable_fields = (
    "origin", "destination", "departureWindow", "idHash", "uniqueTripChains", "uniqueRouteChains", "rankingMethod", "rankingScope", "availableStrategies", "strategyCandidates",
    "tripChainIds", "searchTruncated", "candidateGraphTruncated", "truncation", "searchDiagnosticsByStage",
)
for revision, items in by_revision.items():
    for field in stable_fields:
        if len({json.dumps(item[field], sort_keys=True) for item in items}) != 1:
            raise SystemExit(f"{revision} is not repeat-stable for {field}; inspect the uploaded JSONL.")

baseline = by_revision["baseline"]
candidate = by_revision["candidate"]
same_hash = baseline[0]["idHash"] == candidate[0]["idHash"]
same_winners = baseline[0]["strategyCandidates"] == candidate[0]["strategyCandidates"]
baseline_chains = set(baseline[0]["tripChainIds"])
candidate_chains = set(candidate[0]["tripChainIds"])
baseline_median = statistics.median(item["searchMs"] for item in baseline)
candidate_median = statistics.median(item["searchMs"] for item in candidate)
delta = ((candidate_median / baseline_median) - 1) * 100 if baseline_median else 0.0
identity_display_limit = 12


def short_identity_delta(identities):
    values = sorted(identities)
    sample = values[:identity_display_limit]
    omitted = len(values) - len(sample)
    suffix = f" (showing {len(sample)} of {len(values)})" if omitted else ""
    return f"`{json.dumps(sample)}`{suffix}"


DIAGNOSTIC_FIELDS = {
    "segments-built": (
        "tripsConsidered", "tripsWithEligibleStops", "segments", "candidateRouteCount",
        "graphRoutesBudgetLimited", "graphRoutesAtLimit", "globalGraphBudgetBinding", "segmentGraphTruncated",
    ),
    "reachability-built": ("transferStates", "routeStates", "reachableStops"),
    "itineraries-ranked": (
        "searchSteps", "firstLegs", "candidateResults", "candidatesWith1Legs", "candidatesWith2Legs",
        "candidatesWith3Legs", "returnedByLegCount", "searchBudgetTruncated", "searchStepLimitReached",
        "candidateResultLimitReached", "candidateSamplingTruncated", "segmentGraphTruncated", "maxQueuedSearchWork",
    ),
}


def compact_diagnostics(record):
    result = {}
    for stage, fields in DIAGNOSTIC_FIELDS.items():
        values = record.get("searchDiagnosticsByStage", {}).get(stage, {})
        result[stage] = {field: values[field] for field in fields if field in values}
    return result


def stage_duration_samples(items, stage, previous_stage=None):
    samples = []
    for item in items:
        timings = item.get("searchTimingsByStage", {})
        elapsed = timings.get(stage, {}).get("elapsedMs")
        previous = 0 if previous_stage is None else timings.get(previous_stage, {}).get("elapsedMs")
        if not isinstance(elapsed, (int, float)) or not isinstance(previous, (int, float)) or elapsed < previous:
            return None
        samples.append(elapsed - previous)
    return samples

print("# Frozen Lviv GTFS replay")
print()
print(f"- Feed SHA-256: `{baseline[0]['archiveSha256']}`")
print(f"- Baseline SHA: `{baseline[0]['revision']}` (three repeat-stable runs)")
print(f"- Candidate SHA: `{candidate[0]['revision']}` (three repeat-stable runs)")
print(f"- OD: `{baseline[0]['origin']}` → `{baseline[0]['destination']}`")
print(f"- Departure window (UTC): `{baseline[0]['departureWindow'][0]}` → `{baseline[0]['departureWindow'][1]}`")
print(f"- Ordered result identity parity: **{'YES' if same_hash else 'NO'}**")
print(f"- FASTEST/CHEAPEST/BALANCED winner parity: **{'YES' if same_winners else 'NO'}**")
print(f"- Added trip-chain identities: {short_identity_delta(candidate_chains - baseline_chains)}")
print(f"- Removed trip-chain identities: {short_identity_delta(baseline_chains - candidate_chains)}")
print(f"- Median search time: {baseline_median:.2f} ms → {candidate_median:.2f} ms ({delta:+.2f}%)")
diagnostics_enabled = any(record.get("searchDiagnosticsByStage") for record in records)
print(f"- Detailed search diagnostics: **{'enabled' if diagnostics_enabled else 'disabled'}**")
print(f"- Peak sampled RSS: {max(item['rssBytes'] for item in baseline) / 1_048_576:.1f} MiB → {max(item['rssBytes'] for item in candidate) / 1_048_576:.1f} MiB")
print(f"- Truncated: baseline `{baseline[0]['searchTruncated']}` / candidate `{candidate[0]['searchTruncated']}`; graph truncated: baseline `{baseline[0]['candidateGraphTruncated']}` / candidate `{candidate[0]['candidateGraphTruncated']}`")
print(f"- Truncation causes: baseline `{json.dumps(baseline[0]['truncation'], sort_keys=True)}`; candidate `{json.dumps(candidate[0]['truncation'], sort_keys=True)}`")
for stage, previous_stage in (("segments-built", None), ("reachability-built", "segments-built"), ("itineraries-ranked", "reachability-built")):
    print(f"- `{stage}` counters: baseline `{json.dumps(compact_diagnostics(baseline[0])[stage], sort_keys=True)}`; candidate `{json.dumps(compact_diagnostics(candidate[0])[stage], sort_keys=True)}`")
    baseline_times = stage_duration_samples(baseline, stage, previous_stage)
    candidate_times = stage_duration_samples(candidate, stage, previous_stage)
    if baseline_times is not None and candidate_times is not None:
        baseline_stage_median = statistics.median(baseline_times)
        candidate_stage_median = statistics.median(candidate_times)
        stage_delta = ((candidate_stage_median / baseline_stage_median) - 1) * 100 if baseline_stage_median else 0.0
        print(f"- `{stage}` median stage duration: {baseline_stage_median:.2f} ms → {candidate_stage_median:.2f} ms ({stage_delta:+.2f}%); samples baseline `{baseline_times}` / candidate `{candidate_times}`")
    else:
        print(f"- `{stage}` median stage duration: unavailable (replay artifact lacks valid cumulative timing samples)")
print()
print("This is one frozen-feed Lviv query, not a live GPS, realtime, staging, production, or complete-routing acceptance test.")
