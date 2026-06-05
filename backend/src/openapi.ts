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
    { name: "Webhooks", description: "Register endpoints to receive POST notifications when groups complete or time out" },
    { name: "Audit",    description: "Audit log — every mutation and authentication event" },
    { name: "System",   description: "System health, logs, and configuration (admin only)" },
    { name: "Admin",    description: "Policy import/export, database backup/restore, and maintenance (admin only)" },
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
        required: ["id","policyId","policyName","aggregationKey","keyField","status","rawEventCount","startTime"],
        properties: {
          id:              { type: "string", format: "uuid" },
          policyId:        { type: "string", format: "uuid" },
          policyName:      { type: "string" },
          aggregationKey:  { type: "string", example: "TRD-9001" },
          keyField:        { type: "string", example: "body.tradeRef" },
          status:          { type: "string", enum: ["in_progress","completed","timed_out"] },
          rawEventCount:   { type: "integer" },
          startTime:       { type: "string", format: "date-time" },
          endTime:         { type: "string", format: "date-time", nullable: true },
          durationMs:      { type: "integer", nullable: true, description: "Duration in milliseconds (completed groups only)" },
          closeReason:     { type: "string", nullable: true, enum: ["policy_timeout", null] },
          lastRawEventAt:  { type: "string", format: "date-time", nullable: true },
        },
      },

      EventGroupDetail: {
        allOf: [
          { $ref: "#/components/schemas/EventGroupSummary" },
          {
            type: "object",
            required: ["rawEvents"],
            properties: {
              rawEvents: {
                type: "array",
                items: { $ref: "#/components/schemas/RawEventDetail" },
              },
            },
          },
        ],
      },

      RawEventDetail: {
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
          totalRawEvents: { type: "integer" },
          byPolicy: {
            type: "array",
            items: {
              type: "object",
              properties: {
                policyId:   { type: "string", format: "uuid" },
                policyName: { type: "string" },
                count:      { type: "integer" },
                rawEvents:  { type: "integer" },
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
        required: ["groupId","rawEventId","aggregationKey","isCradle","isGrave","action","status"],
        properties: {
          groupId:        { type: "string", format: "uuid" },
          rawEventId:     { type: "string", format: "uuid" },
          aggregationKey: { type: "string" },
          isCradle:       { type: "boolean" },
          isGrave:        { type: "boolean" },
          action:         { type: "string", enum: ["group_opened","raw_event_appended","group_promoted"] },
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

      Webhook: {
        type: "object",
        required: ["id","name","url","secret","events","isActive","createdAt","updatedAt"],
        properties: {
          id:        { type: "string", format: "uuid" },
          name:      { type: "string", example: "Slack alerts" },
          url:       { type: "string", format: "uri", example: "https://hooks.slack.com/services/xxx" },
          secret:    { type: "string", description: "HMAC-SHA256 signing secret. Empty string means no signature.", example: "" },
          events:    { type: "array", items: { type: "string", enum: ["group_completed","group_timed_out"] }, example: ["group_completed","group_timed_out"] },
          isActive:  { type: "boolean" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },

      WebhookDelivery: {
        type: "object",
        required: ["id","webhookId","webhookName","eventType","groupId","status","attempts","createdAt"],
        properties: {
          id:             { type: "string", format: "uuid" },
          webhookId:      { type: "string", format: "uuid" },
          webhookName:    { type: "string" },
          eventType:      { type: "string", enum: ["group_completed","group_timed_out"] },
          groupId:        { type: "string", format: "uuid" },
          status:         { type: "string", enum: ["pending","success","failed"] },
          attempts:       { type: "integer", minimum: 0 },
          lastAttemptAt:  { type: "string", format: "date-time", nullable: true },
          responseStatus: { type: "integer", nullable: true, description: "HTTP status code returned by the receiver" },
          responseBody:   { type: "string", nullable: true, description: "First 1000 chars of the receiver's response body" },
          errorMessage:   { type: "string", nullable: true, description: "Network or timeout error message" },
          createdAt:      { type: "string", format: "date-time" },
        },
      },

      WebhookEventPayload: {
        type: "object",
        description: "Body sent to a registered webhook URL on every matching event.",
        required: ["event","timestamp","group"],
        properties: {
          event:     { type: "string", enum: ["group_completed","group_timed_out"], description: "The event type that triggered this delivery" },
          timestamp: { type: "string", format: "date-time", description: "ISO 8601 timestamp of delivery (server time)" },
          group: {
            type: "object",
            required: ["id","policyId","policyName","aggregationKey","status","rawEventCount","startTime","endTime","durationMs"],
            properties: {
              id:             { type: "string", format: "uuid" },
              policyId:       { type: "string", format: "uuid" },
              policyName:     { type: "string" },
              aggregationKey: { type: "string" },
              status:         { type: "string", enum: ["completed","timed_out"] },
              rawEventCount:  { type: "integer" },
              startTime:      { type: "string", format: "date-time" },
              endTime:        { type: "string", format: "date-time" },
              durationMs:     { type: "integer" },
            },
          },
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
          { name: "bodySearch", in: "query", schema: { type: "string", maxLength: 500 }, description: "Full-text search across raw event JSON bodies" },
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
        description: "Returns a single event group including all raw events in sequence order.",
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

    // ── Webhooks ──────────────────────────────────────────────────────────
    "/webhooks": {
      get: {
        tags: ["Webhooks"],
        summary: "List webhooks",
        description: "Returns all registered webhook endpoints.",
        security: [{ cookieAuth: [] }],
        responses: {
          "200": { description: "Webhook list", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Webhook" } } } } },
        },
      },
      post: {
        tags: ["Webhooks"],
        summary: "Create a webhook",
        description: "Register a new endpoint. Requires editor or admin role.",
        security: [{ cookieAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name","url"],
                properties: {
                  name:   { type: "string", example: "Slack alerts" },
                  url:    { type: "string", format: "uri", example: "https://hooks.slack.com/services/xxx" },
                  secret: { type: "string", description: "Optional HMAC-SHA256 signing secret. Omit or empty string for no signature.", example: "" },
                  events: { type: "array", items: { type: "string", enum: ["group_completed","group_timed_out"] }, default: ["group_completed","group_timed_out"] },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Webhook created", content: { "application/json": { schema: { $ref: "#/components/schemas/Webhook" } } } },
          "400": { $ref: "#/components/responses/BadRequest" },
        },
      },
    },

    "/webhooks/{id}": {
      put: {
        tags: ["Webhooks"],
        summary: "Update a webhook",
        description: "Update any field on an existing webhook. Requires editor or admin role.",
        security: [{ cookieAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name:     { type: "string" },
                  url:      { type: "string", format: "uri" },
                  secret:   { type: "string" },
                  events:   { type: "array", items: { type: "string", enum: ["group_completed","group_timed_out"] } },
                  isActive: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Updated webhook", content: { "application/json": { schema: { $ref: "#/components/schemas/Webhook" } } } },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      delete: {
        tags: ["Webhooks"],
        summary: "Delete a webhook",
        description: "Permanently removes the webhook and all its delivery history. Requires editor or admin role.",
        security: [{ cookieAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Deleted" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    "/webhooks/deliveries": {
      get: {
        tags: ["Webhooks"],
        summary: "List delivery log",
        description: "Returns recent webhook delivery attempts across all webhooks, or scoped to a single webhook. Includes status, HTTP response code, and error messages.",
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: "webhookId", in: "query", schema: { type: "string", format: "uuid" }, description: "Filter to deliveries for a specific webhook" },
          { name: "limit",     in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 }, description: "Maximum number of deliveries to return" },
        ],
        responses: {
          "200": { description: "Delivery list", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/WebhookDelivery" } } } } },
        },
      },
    },

    // ── Audit ─────────────────────────────────────────────────────────────
    "/audit": {
      get: {
        tags: ["Audit"],
        summary: "Query audit log",
        description: "Returns paginated audit log entries. Requires authentication. Supports filtering by action, actor, entity type, and time range.",
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: "entityType", in: "query", schema: { type: "string" }, description: "Filter by entity type (e.g. policy, user)" },
          { name: "entityId",   in: "query", schema: { type: "string" }, description: "Filter by entity ID" },
          { name: "action",     in: "query", schema: { type: "string" }, description: "Filter by action (partial match, e.g. policy.created)" },
          { name: "actor",      in: "query", schema: { type: "string" }, description: "Filter by actor email (partial match)" },
          { $ref: "#/components/parameters/from" },
          { $ref: "#/components/parameters/to" },
          { name: "limit",  in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 200 } },
          { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
        ],
        responses: {
          "200": {
            description: "Paginated audit log",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    rows:   { type: "array", items: { type: "object", additionalProperties: true } },
                    total:  { type: "integer", description: "Total matching entries (for pagination)" },
                    limit:  { type: "integer" },
                    offset: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
    },

    // ── System ────────────────────────────────────────────────────────────
    "/system/health": {
      get: {
        tags: ["System"],
        summary: "System health",
        description: "Returns CPU, memory, disk, backend process stats, and database metrics. Samples CPU over 250ms. Admin only.",
        security: [{ cookieAuth: [] }],
        responses: {
          "200": {
            description: "Health snapshot",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    timestamp: { type: "string", format: "date-time" },
                    backend:   { type: "object", additionalProperties: true },
                    host:      { type: "object", additionalProperties: true },
                    system:    { type: "object", additionalProperties: true },
                    database:  { type: "object", additionalProperties: true },
                  },
                },
              },
            },
          },
          "403": { description: "Forbidden — admin role required" },
        },
      },
    },

    "/system/config/{key}": {
      get: {
        tags: ["System"],
        summary: "Get system config value",
        description: "Returns the JSONB value stored for the given config key. Admin only.",
        security: [{ cookieAuth: [] }],
        parameters: [{ name: "key", in: "path", required: true, schema: { type: "string" }, example: "smtp" }],
        responses: {
          "200": { description: "Config value (arbitrary JSON)", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      put: {
        tags: ["System"],
        summary: "Set system config value",
        description: "Upserts a JSONB value for the given config key. Admin only.",
        security: [{ cookieAuth: [] }],
        parameters: [{ name: "key", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
        },
        responses: {
          "200": { description: "Saved", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } } },
        },
      },
    },

    "/system/config/smtp/test": {
      post: {
        tags: ["System"],
        summary: "Test SMTP connection",
        description: "Attempts to verify the provided SMTP credentials without sending an email. Admin only.",
        security: [{ cookieAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["host","port","secure","user","password"],
                properties: {
                  host:     { type: "string", example: "smtp.example.com" },
                  port:     { type: "integer", example: 587 },
                  secure:   { type: "boolean", example: false },
                  user:     { type: "string" },
                  password: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Connection verified", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, message: { type: "string" } } } } } },
          "400": { description: "Connection failed", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } } } } },
        },
      },
    },

    "/system/logs/{service}": {
      get: {
        tags: ["System"],
        summary: "Read service log",
        description: "Returns the tail of a supervisor-managed log file. Admin only.",
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: "service", in: "path", required: true, schema: { type: "string", enum: ["backend","nginx","postgres"] } },
          { name: "lines",   in: "query", schema: { type: "integer", minimum: 1, maximum: 2000, default: 200 } },
        ],
        responses: {
          "200": {
            description: "Log lines",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    service: { type: "string" },
                    lines:   { type: "array", items: { type: "string" } },
                    errors:  { type: "array", items: { type: "string" }, description: "Lines containing error/warn/fatal keywords" },
                  },
                },
              },
            },
          },
          "404": { description: "Unknown service" },
        },
      },
    },

    "/system/logs/sizes": {
      get: {
        tags: ["System"],
        summary: "Log file sizes",
        description: "Returns the size of each supervisor log file. Admin only.",
        security: [{ cookieAuth: [] }],
        responses: {
          "200": {
            description: "Log sizes",
            content: {
              "application/json": {
                schema: { type: "array", items: { type: "object", properties: { file: { type: "string" }, size_bytes: { type: "integer" }, size_human: { type: "string" }, modified: { type: "string", format: "date-time" } } } },
              },
            },
          },
        },
      },
    },

    "/system/logs/rotate": {
      post: {
        tags: ["System"],
        summary: "Rotate logs",
        description: "Forces logrotate on the eventagg log config. Admin only.",
        security: [{ cookieAuth: [] }],
        responses: {
          "200": { description: "Rotation result", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, output: { type: "string" } } } } } },
        },
      },
    },

    // ── Admin ─────────────────────────────────────────────────────────────
    "/admin/export/policies": {
      get: {
        tags: ["Admin"],
        summary: "Export policies",
        description: "Downloads all policies as a JSON bundle. Admin only.",
        security: [{ cookieAuth: [] }],
        responses: {
          "200": {
            description: "Policy bundle JSON",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    version:     { type: "string" },
                    exported_at: { type: "string", format: "date-time" },
                    exported_by: { type: "string" },
                    policies:    { type: "array", items: { type: "object", additionalProperties: true } },
                  },
                },
              },
            },
          },
        },
      },
    },

    "/admin/import/policies": {
      post: {
        tags: ["Admin"],
        summary: "Import policies",
        description: "Imports a policy bundle. Existing policies matched by name are updated; new ones are created. Admin only.",
        security: [{ cookieAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["version","policies"],
                properties: {
                  version:  { type: "string" },
                  policies: { type: "array", items: { type: "object", additionalProperties: true } },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Import result",
            content: {
              "application/json": {
                schema: { type: "object", properties: { imported: { type: "integer" }, updated: { type: "integer" }, errors: { type: "array", items: { type: "string" } } } },
              },
            },
          },
        },
      },
    },

    "/admin/backup/info": {
      get: {
        tags: ["Admin"],
        summary: "Backup info",
        description: "Returns database size and row counts for key tables. Admin only.",
        security: [{ cookieAuth: [] }],
        responses: {
          "200": { description: "Backup info", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
        },
      },
    },

    "/admin/backup": {
      post: {
        tags: ["Admin"],
        summary: "Download backup",
        description: "Runs pg_dump and streams a full SQL backup. Admin only.",
        security: [{ cookieAuth: [] }],
        responses: {
          "200": { description: "SQL dump file", content: { "application/sql": { schema: { type: "string", format: "binary" } } } },
        },
      },
    },

    "/admin/restore": {
      post: {
        tags: ["Admin"],
        summary: "Restore from backup",
        description: "Executes a PostgreSQL SQL dump against the live database. Destructive — use with caution. Admin only.",
        security: [{ cookieAuth: [] }],
        requestBody: {
          required: true,
          content: { "application/sql": { schema: { type: "string", format: "binary" } } },
        },
        responses: {
          "200": { description: "Restore completed", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, message: { type: "string" } } } } } },
          "400": { $ref: "#/components/responses/BadRequest" },
        },
      },
    },

    "/admin/db/stats": {
      get: {
        tags: ["Admin"],
        summary: "Database table statistics",
        description: "Returns per-table size, live rows, dead rows, and vacuum history from pg_stat_user_tables. Admin only.",
        security: [{ cookieAuth: [] }],
        responses: {
          "200": { description: "DB stats", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
        },
      },
    },

    "/admin/db/vacuum": {
      post: {
        tags: ["Admin"],
        summary: "VACUUM ANALYZE",
        description: "Runs VACUUM ANALYZE on the entire database to reclaim storage and update planner stats. Admin only.",
        security: [{ cookieAuth: [] }],
        responses: {
          "200": { description: "Vacuum complete", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, message: { type: "string" } } } } } },
        },
      },
    },

    "/admin/db/purge": {
      post: {
        tags: ["Admin"],
        summary: "Purge old data",
        description: "Deletes completed events and audit log entries older than the specified number of days (minimum 30). Admin only.",
        security: [{ cookieAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["days"], properties: { days: { type: "integer", minimum: 30, example: 90 } } },
            },
          },
        },
        responses: {
          "200": {
            description: "Purge result",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok:                { type: "boolean" },
                    deleted_completed: { type: "integer" },
                    deleted_audit:     { type: "integer" },
                    message:           { type: "string" },
                  },
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
        },
      },
    },
  },
};
