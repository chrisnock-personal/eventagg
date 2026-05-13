// ─── Aggre/Gator OpenAPI Specification ───────────────────────────────────────
// Generated from route Zod schemas. Served at GET /api/v1/openapi.json
// and rendered at GET /api/v1/docs via Swagger UI.

export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Aggre/Gator API",
    version: "1.0.0",
    description:
      "Intelligent event stream aggregation. Ingest events from any source, " +
      "group them by configurable key, track cradle-to-grave lifecycle, and " +
      "surface real-time insights. All core features are available headlessly via this API.",
    contact: { name: "Aggre/Gator", url: "https://github.com/your-org/aggre-gator" },
  },
  servers: [{ url: "/api/v1", description: "Current instance" }],

  tags: [
    { name: "Events",   description: "Event group queries, stats, and performance" },
    { name: "Ingest",   description: "Push events into the aggregation engine" },
    { name: "Policies", description: "Manage aggregation policies" },
  ],

  // ── Reusable schemas ──────────────────────────────────────────────────────
  components: {
    schemas: {
      Policy: {
        type: "object",
        required: ["id","name","domain","keyField","cradleField","cradleValue","graveField","graveValue","isActive","createdAt","updatedAt"],
        properties: {
          id:           { type: "string", format: "uuid" },
          name:         { type: "string", example: "Trade Lifecycle" },
          domain:       { type: "string", example: "trade.*" },
          keyField:     { type: "string", example: "body.tradeRef", description: "Dot-notation path to aggregation key" },
          cradleField:  { type: "string", example: "body.eventType" },
          cradleValue:  { type: "string", example: "trade.initiated" },
          graveField:   { type: "string", example: "body.status" },
          graveValue:   { type: "string", example: "settled" },
          description:  { type: "string", nullable: true },
          isActive:     { type: "boolean" },
          timeoutMs:    { type: "integer", nullable: true, description: "Auto-close groups after this ms of inactivity. null = no timeout." },
          createdAt:    { type: "string", format: "date-time" },
          updatedAt:    { type: "string", format: "date-time" },
        },
      },

      EventGroupSummary: {
        type: "object",
        required: ["id","policyId","policyName","aggregationKey","keyField","status","segmentCount","startTime"],
        properties: {
          id:             { type: "string", format: "uuid" },
          policyId:       { type: "string", format: "uuid" },
          policyName:     { type: "string" },
          aggregationKey: { type: "string", example: "TRD-9001" },
          keyField:       { type: "string", example: "body.tradeRef" },
          status:         { type: "string", enum: ["in_progress","completed","timed_out"] },
          segmentCount:   { type: "integer" },
          startTime:      { type: "string", format: "date-time" },
          endTime:        { type: "string", format: "date-time", nullable: true },
          durationMs:     { type: "integer", nullable: true, description: "Duration in milliseconds (completed groups only)" },
          closeReason:    { type: "string", nullable: true, enum: ["policy_timeout", null] },
          lastSegmentAt:  { type: "string", format: "date-time", nullable: true },
        },
      },

      EventGroupDetail: {
        allOf: [
          { $ref: "#/components/schemas/EventGroupSummary" },
          {
            type: "object",
            required: ["segments"],
            properties: {
              segments: {
                type: "array",
                items: { $ref: "#/components/schemas/SegmentDetail" },
              },
            },
          },
        ],
      },

      SegmentDetail: {
        type: "object",
        required: ["eventId","sequence","isCradle","isGrave","timestamp","body"],
        properties: {
          eventId:   { type: "string", format: "uuid" },
          sequence:  { type: "integer" },
          isCradle:  { type: "boolean" },
          isGrave:   { type: "boolean" },
          timestamp: { type: "string", format: "date-time" },
          body:      { type: "object", additionalProperties: true },
        },
      },

      EventStats: {
        type: "object",
        properties: {
          totalGroups:    { type: "integer" },
          completed:      { type: "integer" },
          inProgress:     { type: "integer" },
          timedOut:       { type: "integer" },
          totalSegments:  { type: "integer" },
          byPolicy: {
            type: "array",
            items: {
              type: "object",
              properties: {
                policyId:   { type: "string", format: "uuid" },
                policyName: { type: "string" },
                count:      { type: "integer" },
                segments:   { type: "integer" },
              },
            },
          },
          throughput: {
            type: "array",
            items: {
              type: "object",
              properties: {
                bucket:  { type: "string", format: "date-time" },
                opened:  { type: "integer" },
                closed:  { type: "integer" },
              },
            },
          },
        },
      },

      IngestResult: {
        type: "object",
        required: ["groupId","segmentId","aggregationKey","isCradle","isGrave","action","status"],
        properties: {
          groupId:        { type: "string", format: "uuid" },
          segmentId:      { type: "string", format: "uuid" },
          aggregationKey: { type: "string" },
          isCradle:       { type: "boolean" },
          isGrave:        { type: "boolean" },
          action:         { type: "string", enum: ["group_opened","segment_appended","group_promoted"] },
          status:         { type: "string", enum: ["in_progress","completed"] },
        },
      },

      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error:   { type: "string" },
          details: { type: "array", items: { type: "object" } },
        },
      },

      PaginatedEvents: {
        type: "object",
        required: ["data","total","page","totalPages"],
        properties: {
          data:       { type: "array", items: { $ref: "#/components/schemas/EventGroupSummary" } },
          total:      { type: "integer" },
          page:       { type: "integer" },
          totalPages: { type: "integer" },
        },
      },
    },

    parameters: {
      policyId: {
        name: "policyId", in: "query", schema: { type: "string", format: "uuid" },
        description: "Filter by policy ID",
      },
      aggregationKey: {
        name: "aggregationKey", in: "query", schema: { type: "string" },
        description: "Filter by exact aggregation key value",
      },
      from: {
        name: "from", in: "query", schema: { type: "string", format: "date-time" },
        description: "Start of time range (ISO 8601 with offset)",
      },
      to: {
        name: "to", in: "query", schema: { type: "string", format: "date-time" },
        description: "End of time range (ISO 8601 with offset)",
      },
      status: {
        name: "status", in: "query",
        schema: { type: "string", enum: ["all","in_progress","completed","timed_out"], default: "all" },
        description: "Filter by event group status",
      },
    },

    responses: {
      NotFound:   { description: "Resource not found",       content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      BadRequest: { description: "Validation error",         content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      ServerError:{ description: "Internal server error",    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
    },
  },

  // ── Paths ─────────────────────────────────────────────────────────────────
  paths: {

    // ── Ingest ────────────────────────────────────────────────────────────
    "/events/ingest": {
      post: {
        tags: ["Ingest"],
        summary: "Ingest an event",
        description:
          "Push a JSON event body into the aggregation engine. The engine matches it " +
          "against active policies, extracts the aggregation key, and either opens a " +
          "new event group, appends to an existing one, or promotes it to completed.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["policyId","body"],
                properties: {
                  policyId: { type: "string", format: "uuid", description: "ID of the policy to evaluate against" },
                  body:     { type: "object", additionalProperties: true, description: "Arbitrary JSON event payload" },
                },
              },
              example: {
                policyId: "550e8400-e29b-41d4-a716-446655440000",
                body: { eventType: "trade.initiated", tradeRef: "TRD-9001", notional: 100000 },
              },
            },
          },
        },
        responses: {
          "200": { description: "Segment appended to existing group", content: { "application/json": { schema: { $ref: "#/components/schemas/IngestResult" } } } },
          "201": { description: "New event group opened (cradle)",    content: { "application/json": { schema: { $ref: "#/components/schemas/IngestResult" } } } },
          "400": { $ref: "#/components/responses/BadRequest" },
          "500": { $ref: "#/components/responses/ServerError" },
        },
      },
    },

    // ── Events ────────────────────────────────────────────────────────────
    "/events": {
      get: {
        tags: ["Events"],
        summary: "List event groups",
        description: "Returns a paginated list of event groups with optional filtering by status, policy, date range, aggregation key, and body content.",
        parameters: [
          { $ref: "#/components/parameters/status" },
          { $ref: "#/components/parameters/policyId" },
          { $ref: "#/components/parameters/aggregationKey" },
          { $ref: "#/components/parameters/from" },
          { $ref: "#/components/parameters/to" },
          { name: "bodySearch", in: "query", schema: { type: "string", maxLength: 500 }, description: "Full-text search across segment JSON bodies" },
          { name: "page",  in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
        ],
        responses: {
          "200": { description: "Paginated event groups", content: { "application/json": { schema: { $ref: "#/components/schemas/PaginatedEvents" } } } },
          "400": { $ref: "#/components/responses/BadRequest" },
        },
      },
    },

    "/events/stats": {
      get: {
        tags: ["Events"],
        summary: "Aggregate statistics",
        description: "Returns aggregate counts, per-policy breakdown, and throughput chart data. Results are cached for 60 seconds (X-Cache header indicates HIT/MISS).",
        parameters: [
          { $ref: "#/components/parameters/status" },
          { $ref: "#/components/parameters/policyId" },
          { $ref: "#/components/parameters/aggregationKey" },
          { $ref: "#/components/parameters/from" },
          { $ref: "#/components/parameters/to" },
        ],
        responses: {
          "200": {
            description: "Statistics",
            headers: { "X-Cache": { schema: { type: "string", enum: ["HIT","MISS"] }, description: "Whether the response was served from cache" } },
            content: { "application/json": { schema: { $ref: "#/components/schemas/EventStats" } } },
          },
        },
      },
    },

    "/events/performance": {
      get: {
        tags: ["Events"],
        summary: "Performance metrics",
        description: "Returns the slowest completed groups, aging in-progress groups, and a duration distribution histogram. Cached for 30 seconds.",
        parameters: [
          { $ref: "#/components/parameters/policyId" },
          { $ref: "#/components/parameters/aggregationKey" },
          { $ref: "#/components/parameters/from" },
          { $ref: "#/components/parameters/to" },
        ],
        responses: {
          "200": {
            description: "Performance data",
            headers: { "X-Cache": { schema: { type: "string", enum: ["HIT","MISS"] } } },
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    slowestCompleted: { type: "array", items: { $ref: "#/components/schemas/EventGroupSummary" } },
                    inProgressAging:  { type: "array", items: { $ref: "#/components/schemas/EventGroupSummary" } },
                    durationHistogram: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          bucket: { type: "string" },
                          count:  { type: "integer" },
                          minMs:  { type: "integer" },
                          maxMs:  { type: "integer" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },

    "/events/{id}": {
      get: {
        tags: ["Events"],
        summary: "Get event group detail",
        description: "Returns a single event group including all segments in sequence order.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": { description: "Event group detail", content: { "application/json": { schema: { $ref: "#/components/schemas/EventGroupDetail" } } } },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    // ── Policies ──────────────────────────────────────────────────────────
    "/policies": {
      get: {
        tags: ["Policies"],
        summary: "List all policies",
        description: "Returns all aggregation policies including inactive ones.",
        responses: {
          "200": { description: "Policy list", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Policy" } } } } },
        },
      },
      post: {
        tags: ["Policies"],
        summary: "Create a policy",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name","keyField","cradleField","cradleValue","graveField","graveValue"],
                properties: {
                  name:         { type: "string" },
                  domain:       { type: "string", default: "*" },
                  keyField:     { type: "string", example: "body.tradeRef" },
                  cradleField:  { type: "string", example: "body.eventType" },
                  cradleValue:  { type: "string", example: "trade.initiated" },
                  graveField:   { type: "string", example: "body.status" },
                  graveValue:   { type: "string", example: "settled" },
                  description:  { type: "string", nullable: true },
                  timeoutMs:    { type: "integer", nullable: true, minimum: 1 },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Policy created", content: { "application/json": { schema: { $ref: "#/components/schemas/Policy" } } } },
          "400": { $ref: "#/components/responses/BadRequest" },
        },
      },
    },

    "/policies/{id}": {
      get: {
        tags: ["Policies"],
        summary: "Get a policy",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Policy", content: { "application/json": { schema: { $ref: "#/components/schemas/Policy" } } } },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      put: {
        tags: ["Policies"],
        summary: "Update a policy",
        description: "Update policy fields. If timeoutMs is set, immediately sweeps existing in-progress groups for that policy.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  domain: { type: "string" },
                  keyField: { type: "string" },
                  cradleField: { type: "string" },
                  cradleValue: { type: "string" },
                  graveField: { type: "string" },
                  graveValue: { type: "string" },
                  description: { type: "string", nullable: true },
                  timeoutMs: { type: "integer", nullable: true, minimum: 1 },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Updated policy", content: { "application/json": { schema: { $ref: "#/components/schemas/Policy" } } } },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      delete: {
        tags: ["Policies"],
        summary: "Delete a policy",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Deleted" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    "/policies/{id}/toggle": {
      patch: {
        tags: ["Policies"],
        summary: "Activate or deactivate a policy",
        description: "Toggles the policy's isActive state. Inactive policies are not evaluated on ingest.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["active"],
                properties: { active: { type: "boolean" } },
              },
            },
          },
        },
        responses: {
          "200": { description: "Updated policy", content: { "application/json": { schema: { $ref: "#/components/schemas/Policy" } } } },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
  },
};
