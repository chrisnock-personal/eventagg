import client from "prom-client";

// prom-client rather than hand-rolled: Prometheus's text-exposition format
// has real spec details (histogram bucket/_sum/_count naming, content-type)
// worth getting from a maintained library. Same reasoning as CallOwl.

export const register = new client.Registry();
client.collectDefaultMetrics({ register }); // process CPU/memory/event-loop-lag

// One histogram covers both latency and error rate: the _bucket/_count series
// per status_code label already supports request counts and 5xx rates with a
// PromQL rate() query, so no separate request counter is needed.
export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"],
  registers: [register],
});

// Labelled by policy so a noisy tenant/policy can be identified, and by the
// engine's own outcome so opened/append/promoted events can be compared.
export const ingestEventsTotal = new client.Counter({
  name: "ingest_events_total",
  help: "Raw events ingested by policy and engine outcome",
  labelNames: ["policy_id", "outcome"],
  registers: [register],
});

// Set on each scrape from in_progress_events rather than maintained in memory,
// so restarts and multiple backend processes cannot leave it stale.
export const inProgressGroups = new client.Gauge({
  name: "in_progress_groups",
  help: "Number of event groups currently in progress",
  registers: [register],
});
