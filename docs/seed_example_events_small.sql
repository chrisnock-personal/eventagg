-- =============================================================================
-- seed_example_events.sql
--
-- Generates example event groups for the four EXAMPLE policies.
-- Uses plain SQL INSERT ... SELECT with hardcoded UUIDs.
-- Safe to run multiple times (ON CONFLICT DO NOTHING on all inserts).
--
-- Run with:
--   psql -h localhost -p 5432 -U eventagg_user -d eventagg \
--     -f seed_example_events.sql
--
-- Or inside the container:
--   podman exec -i eventagg psql -U eventagg_user -d eventagg \
--     < seed_example_events.sql
-- =============================================================================

-- =============================================================================
-- USER SESSION -3 completed, 1 in-progress
-- =============================================================================

-- ── Completed session 1: quick browse ────────────────────────────────────────
INSERT INTO completed_events
  (id, policy_id, aggregation_key, key_field, segment_count,
   cradle_segment_id, grave_segment_id, started_at, ended_at, completed_at)
SELECT
  'cc000001-0000-0000-0000-000000000001'::uuid, p.id,
  'sess-U001-A', 'sessionId', 3,
  '5e000001-0000-0000-0000-000000000001'::uuid,
  '5e000001-0000-0000-0000-000000000003'::uuid,
  now() - INTERVAL '6 hours',
  now() - INTERVAL '6 hours' + INTERVAL '8 minutes',
  now() - INTERVAL '6 hours' + INTERVAL '8 minutes'
FROM policies p WHERE p.name = 'EXAMPLE - User Session' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

INSERT INTO event_segments
  (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
SELECT s.id, 'cc000001-0000-0000-0000-000000000001'::uuid, p.id,
  'sess-U001-A', s.seq, s.cradle, s.grave, s.body::jsonb, now() - INTERVAL '6 hours' + s.dt 
FROM policies p,
(VALUES
  ('5e000001-0000-0000-0000-000000000001'::uuid, 1, TRUE,  FALSE, '{"eventType":"user.login","sessionId":"sess-U001-A","userId":"usr-001","ipAddress":"82.45.12.201"}',                    INTERVAL '0'),
  ('5e000001-0000-0000-0000-000000000002'::uuid, 2, FALSE, FALSE, '{"eventType":"user.action","sessionId":"sess-U001-A","userId":"usr-001","action":"view_dashboard","page":"/dashboard"}', INTERVAL '3 minutes'),
  ('5e000001-0000-0000-0000-000000000003'::uuid, 3, FALSE, TRUE,  '{"eventType":"user.logout","sessionId":"sess-U001-A","userId":"usr-001","reason":"explicit"}',                           INTERVAL '8 minutes')
) AS s(id, seq, cradle, grave, body, dt)
WHERE p.name = 'EXAMPLE - User Session' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

-- ── Completed session 2: longer session ──────────────────────────────────────
INSERT INTO completed_events
  (id, policy_id, aggregation_key, key_field, segment_count,
   cradle_segment_id, grave_segment_id, started_at, ended_at, completed_at)
SELECT
  'cc000002-0000-0000-0000-000000000001'::uuid, p.id,
  'sess-U002-B', 'sessionId', 5,
  '5e000002-0000-0000-0000-000000000001'::uuid,
  '5e000002-0000-0000-0000-000000000005'::uuid,
  now() - INTERVAL '4 hours 15 minutes',
  now() - INTERVAL '4 hours 15 minutes' + INTERVAL '42 minutes',
  now() - INTERVAL '4 hours 15 minutes' + INTERVAL '42 minutes'
FROM policies p WHERE p.name = 'EXAMPLE - User Session' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

INSERT INTO event_segments
  (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
SELECT s.id, 'cc000002-0000-0000-0000-000000000001'::uuid, p.id,
  'sess-U002-B', s.seq, s.cradle, s.grave, s.body::jsonb, now() - INTERVAL '4 hours 15 minutes' + s.dt 
FROM policies p,
(VALUES
  ('5e000002-0000-0000-0000-000000000001'::uuid, 1, TRUE,  FALSE, '{"eventType":"user.login","sessionId":"sess-U002-B","userId":"usr-002","ipAddress":"194.168.1.55"}',                         INTERVAL '0'),
  ('5e000002-0000-0000-0000-000000000002'::uuid, 2, FALSE, FALSE, '{"eventType":"user.action","sessionId":"sess-U002-B","userId":"usr-002","action":"view_reports","page":"/reports"}',          INTERVAL '5 minutes'),
  ('5e000002-0000-0000-0000-000000000003'::uuid, 3, FALSE, FALSE, '{"eventType":"user.action","sessionId":"sess-U002-B","userId":"usr-002","action":"export_csv","page":"/reports"}',             INTERVAL '18 minutes'),
  ('5e000002-0000-0000-0000-000000000004'::uuid, 4, FALSE, FALSE, '{"eventType":"user.action","sessionId":"sess-U002-B","userId":"usr-002","action":"view_settings","page":"/settings"}',         INTERVAL '35 minutes'),
  ('5e000002-0000-0000-0000-000000000005'::uuid, 5, FALSE, TRUE,  '{"eventType":"user.logout","sessionId":"sess-U002-B","userId":"usr-002","reason":"timeout"}',                                  INTERVAL '42 minutes')
) AS s(id, seq, cradle, grave, body, dt)
WHERE p.name = 'EXAMPLE - User Session' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

-- ── Completed session 3: recent ───────────────────────────────────────────────
INSERT INTO completed_events
  (id, policy_id, aggregation_key, key_field, segment_count,
   cradle_segment_id, grave_segment_id, started_at, ended_at, completed_at)
SELECT
  'cc000003-0000-0000-0000-000000000001'::uuid, p.id,
  'sess-U003-C', 'sessionId', 2,
  '5e000003-0000-0000-0000-000000000001'::uuid,
  '5e000003-0000-0000-0000-000000000002'::uuid,
  now() - INTERVAL '45 minutes',
  now() - INTERVAL '45 minutes' + INTERVAL '3 minutes',
  now() - INTERVAL '45 minutes' + INTERVAL '3 minutes'
FROM policies p WHERE p.name = 'EXAMPLE - User Session' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

INSERT INTO event_segments
  (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
SELECT s.id, 'cc000003-0000-0000-0000-000000000001'::uuid, p.id,
  'sess-U003-C', s.seq, s.cradle, s.grave, s.body::jsonb, now() - INTERVAL '45 minutes' + s.dt 
FROM policies p,
(VALUES
  ('5e000003-0000-0000-0000-000000000001'::uuid, 1, TRUE, FALSE, '{"eventType":"user.login","sessionId":"sess-U003-C","userId":"usr-003","ipAddress":"10.0.0.44"}', INTERVAL '0'),
  ('5e000003-0000-0000-0000-000000000002'::uuid, 2, FALSE, TRUE, '{"eventType":"user.logout","sessionId":"sess-U003-C","userId":"usr-003","reason":"explicit"}',   INTERVAL '3 minutes')
) AS s(id, seq, cradle, grave, body, dt)
WHERE p.name = 'EXAMPLE - User Session' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

-- ── In-progress session ───────────────────────────────────────────────────────
INSERT INTO in_progress_events
  (id, policy_id, aggregation_key, key_field, segment_count,
   cradle_segment_id, started_at, last_seen_at)
SELECT
  '1b000001-0000-0000-0000-000000000001'::uuid, p.id,
  'sess-U004-D', 'sessionId', 2,
  '5e000004-0000-0000-0000-000000000001'::uuid,
  now() - INTERVAL '12 minutes',
  now() - INTERVAL '5 minutes'
FROM policies p WHERE p.name = 'EXAMPLE - User Session' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

INSERT INTO event_segments
  (id, in_progress_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
SELECT s.id, '1b000001-0000-0000-0000-000000000001'::uuid, p.id,
  'sess-U004-D', s.seq, s.cradle, s.grave, s.body::jsonb, now() - INTERVAL '12 minutes' + s.dt 
FROM policies p,
(VALUES
  ('5e000004-0000-0000-0000-000000000001'::uuid, 1, TRUE,  FALSE, '{"eventType":"user.login","sessionId":"sess-U004-D","userId":"usr-004","ipAddress":"172.16.0.9"}',              INTERVAL '0'),
  ('5e000004-0000-0000-0000-000000000002'::uuid, 2, FALSE, FALSE, '{"eventType":"user.action","sessionId":"sess-U004-D","userId":"usr-004","action":"view_dashboard","page":"/dashboard"}', INTERVAL '7 minutes')
) AS s(id, seq, cradle, grave, body, dt)
WHERE p.name = 'EXAMPLE - User Session' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;


-- =============================================================================
-- TRADE LIFECYCLE -3 completed, 1 in-progress
-- =============================================================================

-- ── Completed trade 1: AAPL equity ────────────────────────────────────────────
INSERT INTO completed_events
  (id, policy_id, aggregation_key, key_field, segment_count,
   cradle_segment_id, grave_segment_id, started_at, ended_at, completed_at)
SELECT
  'cc000004-0000-0000-0000-000000000001'::uuid, p.id,
  'TRD-9001', 'tradeRef', 4,
  '5e000005-0000-0000-0000-000000000001'::uuid,
  '5e000005-0000-0000-0000-000000000004'::uuid,
  now() - INTERVAL '5 hours',
  now() - INTERVAL '5 hours' + INTERVAL '2 hours 15 minutes',
  now() - INTERVAL '5 hours' + INTERVAL '2 hours 15 minutes'
FROM policies p WHERE p.name = 'EXAMPLE - Trade Lifecycle' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

INSERT INTO event_segments
  (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
SELECT s.id, 'cc000004-0000-0000-0000-000000000001'::uuid, p.id,
  'TRD-9001', s.seq, s.cradle, s.grave, s.body::jsonb, now() - INTERVAL '5 hours' + s.dt 
FROM policies p,
(VALUES
  ('5e000005-0000-0000-0000-000000000001'::uuid, 1, TRUE,  FALSE, '{"eventType":"trade.initiated","tradeRef":"TRD-9001","symbol":"AAPL","side":"BUY","qty":500,"price":182.34,"trader":"t-smith"}',   INTERVAL '0'),
  ('5e000005-0000-0000-0000-000000000002'::uuid, 2, FALSE, FALSE, '{"eventType":"trade.confirmed","tradeRef":"TRD-9001","symbol":"AAPL","confirmedAt":"exchange","exchangeRef":"EX-44821"}',          INTERVAL '4 seconds'),
  ('5e000005-0000-0000-0000-000000000003'::uuid, 3, FALSE, FALSE, '{"eventType":"trade.clearing","tradeRef":"TRD-9001","clearingHouse":"LCH","clearingRef":"CLR-99201"}',                             INTERVAL '30 minutes'),
  ('5e000005-0000-0000-0000-000000000004'::uuid, 4, FALSE, TRUE,  '{"eventType":"trade.settled","tradeRef":"TRD-9001","status":"settled","settlementDate":"T+2","netAmount":91170.00}',               INTERVAL '2 hours 15 minutes')
) AS s(id, seq, cradle, grave, body, dt)
WHERE p.name = 'EXAMPLE - Trade Lifecycle' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

-- ── Completed trade 2: GBP/USD FX ────────────────────────────────────────────
INSERT INTO completed_events
  (id, policy_id, aggregation_key, key_field, segment_count,
   cradle_segment_id, grave_segment_id, started_at, ended_at, completed_at)
SELECT
  'cc000005-0000-0000-0000-000000000001'::uuid, p.id,
  'TRD-9002', 'tradeRef', 3,
  '5e000006-0000-0000-0000-000000000001'::uuid,
  '5e000006-0000-0000-0000-000000000003'::uuid,
  now() - INTERVAL '3 hours 30 minutes',
  now() - INTERVAL '3 hours 30 minutes' + INTERVAL '55 minutes',
  now() - INTERVAL '3 hours 30 minutes' + INTERVAL '55 minutes'
FROM policies p WHERE p.name = 'EXAMPLE - Trade Lifecycle' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

INSERT INTO event_segments
  (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
SELECT s.id, 'cc000005-0000-0000-0000-000000000001'::uuid, p.id,
  'TRD-9002', s.seq, s.cradle, s.grave, s.body::jsonb, now() - INTERVAL '3 hours 30 minutes' + s.dt 
FROM policies p,
(VALUES
  ('5e000006-0000-0000-0000-000000000001'::uuid, 1, TRUE,  FALSE, '{"eventType":"trade.initiated","tradeRef":"TRD-9002","symbol":"GBP/USD","side":"SELL","qty":1000000,"rate":1.2654,"trader":"t-jones"}', INTERVAL '0'),
  ('5e000006-0000-0000-0000-000000000002'::uuid, 2, FALSE, FALSE, '{"eventType":"trade.confirmed","tradeRef":"TRD-9002","symbol":"GBP/USD","confirmedAt":"broker","brokerRef":"BRK-00772"}',               INTERVAL '2 seconds'),
  ('5e000006-0000-0000-0000-000000000003'::uuid, 3, FALSE, TRUE,  '{"eventType":"trade.settled","tradeRef":"TRD-9002","status":"settled","settlementDate":"T+1","netAmount":1265400.00}',                  INTERVAL '55 minutes')
) AS s(id, seq, cradle, grave, body, dt)
WHERE p.name = 'EXAMPLE - Trade Lifecycle' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

-- ── Completed trade 3: MSFT ────────────────────────────────────────────────────
INSERT INTO completed_events
  (id, policy_id, aggregation_key, key_field, segment_count,
   cradle_segment_id, grave_segment_id, started_at, ended_at, completed_at)
SELECT
  'cc000006-0000-0000-0000-000000000001'::uuid, p.id,
  'TRD-9003', 'tradeRef', 3,
  '5e000007-0000-0000-0000-000000000001'::uuid,
  '5e000007-0000-0000-0000-000000000003'::uuid,
  now() - INTERVAL '1 hour 10 minutes',
  now() - INTERVAL '1 hour 10 minutes' + INTERVAL '18 minutes',
  now() - INTERVAL '1 hour 10 minutes' + INTERVAL '18 minutes'
FROM policies p WHERE p.name = 'EXAMPLE - Trade Lifecycle' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

INSERT INTO event_segments
  (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
SELECT s.id, 'cc000006-0000-0000-0000-000000000001'::uuid, p.id,
  'TRD-9003', s.seq, s.cradle, s.grave, s.body::jsonb, now() - INTERVAL '1 hour 10 minutes' + s.dt 
FROM policies p,
(VALUES
  ('5e000007-0000-0000-0000-000000000001'::uuid, 1, TRUE,  FALSE, '{"eventType":"trade.initiated","tradeRef":"TRD-9003","symbol":"MSFT","side":"BUY","qty":200,"price":415.20,"trader":"t-patel"}', INTERVAL '0'),
  ('5e000007-0000-0000-0000-000000000002'::uuid, 2, FALSE, FALSE, '{"eventType":"trade.confirmed","tradeRef":"TRD-9003","symbol":"MSFT","confirmedAt":"exchange","exchangeRef":"EX-44900"}',       INTERVAL '3 seconds'),
  ('5e000007-0000-0000-0000-000000000003'::uuid, 3, FALSE, TRUE,  '{"eventType":"trade.settled","tradeRef":"TRD-9003","status":"settled","settlementDate":"T+2","netAmount":83040.00}',            INTERVAL '18 minutes')
) AS s(id, seq, cradle, grave, body, dt)
WHERE p.name = 'EXAMPLE - Trade Lifecycle' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

-- ── In-progress trade: NVDA awaiting settlement ───────────────────────────────
INSERT INTO in_progress_events
  (id, policy_id, aggregation_key, key_field, segment_count,
   cradle_segment_id, started_at, last_seen_at)
SELECT
  '1b000002-0000-0000-0000-000000000001'::uuid, p.id,
  'TRD-9004', 'tradeRef', 2,
  '5e000008-0000-0000-0000-000000000001'::uuid,
  now() - INTERVAL '8 minutes',
  now() - INTERVAL '8 minutes' + INTERVAL '5 seconds'
FROM policies p WHERE p.name = 'EXAMPLE - Trade Lifecycle' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

INSERT INTO event_segments
  (id, in_progress_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
SELECT s.id, '1b000002-0000-0000-0000-000000000001'::uuid, p.id,
  'TRD-9004', s.seq, s.cradle, s.grave, s.body::jsonb, now() - INTERVAL '8 minutes' + s.dt 
FROM policies p,
(VALUES
  ('5e000008-0000-0000-0000-000000000001'::uuid, 1, TRUE,  FALSE, '{"eventType":"trade.initiated","tradeRef":"TRD-9004","symbol":"NVDA","side":"BUY","qty":50,"price":878.50,"trader":"t-smith"}', INTERVAL '0'),
  ('5e000008-0000-0000-0000-000000000002'::uuid, 2, FALSE, FALSE, '{"eventType":"trade.confirmed","tradeRef":"TRD-9004","symbol":"NVDA","confirmedAt":"exchange","exchangeRef":"EX-45010"}',      INTERVAL '5 seconds')
) AS s(id, seq, cradle, grave, body, dt)
WHERE p.name = 'EXAMPLE - Trade Lifecycle' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;


-- =============================================================================
-- ORDER FLOW -2 completed, 1 in-progress
-- =============================================================================

-- ── Completed order 1: full lifecycle ─────────────────────────────────────────
INSERT INTO completed_events
  (id, policy_id, aggregation_key, key_field, segment_count,
   cradle_segment_id, grave_segment_id, started_at, ended_at, completed_at)
SELECT
  'cc000007-0000-0000-0000-000000000001'::uuid, p.id,
  'ORD-10045', 'orderId', 5,
  '5e000009-0000-0000-0000-000000000001'::uuid,
  '5e000009-0000-0000-0000-000000000005'::uuid,
  now() - INTERVAL '72 hours',
  now() - INTERVAL '72 hours' + INTERVAL '68 hours',
  now() - INTERVAL '72 hours' + INTERVAL '68 hours'
FROM policies p WHERE p.name = 'EXAMPLE - Order Flow' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

INSERT INTO event_segments
  (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
SELECT s.id, 'cc000007-0000-0000-0000-000000000001'::uuid, p.id,
  'ORD-10045', s.seq, s.cradle, s.grave, s.body::jsonb, now() - INTERVAL '72 hours' + s.dt 
FROM policies p,
(VALUES
  ('5e000009-0000-0000-0000-000000000001'::uuid, 1, TRUE,  FALSE, '{"eventType":"order.created","orderId":"ORD-10045","customerId":"cust-881","items":[{"sku":"WIDGET-A","qty":2,"price":24.99}],"total":99.97}',   INTERVAL '0'),
  ('5e000009-0000-0000-0000-000000000002'::uuid, 2, FALSE, FALSE, '{"eventType":"order.payment","orderId":"ORD-10045","method":"card","amount":99.97,"reference":"PAY-99112"}',                                     INTERVAL '2 minutes'),
  ('5e000009-0000-0000-0000-000000000003'::uuid, 3, FALSE, FALSE, '{"eventType":"order.picked","orderId":"ORD-10045","warehouseId":"WH-02","pickedBy":"staff-44"}',                                                 INTERVAL '4 hours'),
  ('5e000009-0000-0000-0000-000000000004'::uuid, 4, FALSE, FALSE, '{"eventType":"order.shipped","orderId":"ORD-10045","carrier":"DHL","trackingRef":"DHL-8821004","estimatedDelivery":"2026-05-10"}',               INTERVAL '6 hours'),
  ('5e000009-0000-0000-0000-000000000005'::uuid, 5, FALSE, TRUE,  '{"eventType":"order.delivered","orderId":"ORD-10045","deliveredAt":"2026-05-10T14:22:00Z","signedBy":"J.Smith"}',                               INTERVAL '68 hours')
) AS s(id, seq, cradle, grave, body, dt)
WHERE p.name = 'EXAMPLE - Order Flow' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

-- ── Completed order 2: recent ─────────────────────────────────────────────────
INSERT INTO completed_events
  (id, policy_id, aggregation_key, key_field, segment_count,
   cradle_segment_id, grave_segment_id, started_at, ended_at, completed_at)
SELECT
  'cc000008-0000-0000-0000-000000000001'::uuid, p.id,
  'ORD-10046', 'orderId', 4,
  '5e000010-0000-0000-0000-000000000001'::uuid,
  '5e000010-0000-0000-0000-000000000004'::uuid,
  now() - INTERVAL '26 hours',
  now() - INTERVAL '26 hours' + INTERVAL '24 hours',
  now() - INTERVAL '26 hours' + INTERVAL '24 hours'
FROM policies p WHERE p.name = 'EXAMPLE - Order Flow' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

INSERT INTO event_segments
  (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
SELECT s.id, 'cc000008-0000-0000-0000-000000000001'::uuid, p.id,
  'ORD-10046', s.seq, s.cradle, s.grave, s.body::jsonb, now() - INTERVAL '26 hours' + s.dt 
FROM policies p,
(VALUES
  ('5e000010-0000-0000-0000-000000000001'::uuid, 1, TRUE,  FALSE, '{"eventType":"order.created","orderId":"ORD-10046","customerId":"cust-204","items":[{"sku":"PART-X9","qty":10,"price":5.50}],"total":55.00}', INTERVAL '0'),
  ('5e000010-0000-0000-0000-000000000002'::uuid, 2, FALSE, FALSE, '{"eventType":"order.payment","orderId":"ORD-10046","method":"paypal","amount":55.00,"reference":"PAY-99234"}',                                 INTERVAL '1 minute'),
  ('5e000010-0000-0000-0000-000000000003'::uuid, 3, FALSE, FALSE, '{"eventType":"order.shipped","orderId":"ORD-10046","carrier":"Royal Mail","trackingRef":"RM-1122334","estimatedDelivery":"2026-05-09"}',       INTERVAL '3 hours'),
  ('5e000010-0000-0000-0000-000000000004'::uuid, 4, FALSE, TRUE,  '{"eventType":"order.delivered","orderId":"ORD-10046","deliveredAt":"2026-05-09T10:05:00Z","signedBy":"Reception"}',                           INTERVAL '24 hours')
) AS s(id, seq, cradle, grave, body, dt)
WHERE p.name = 'EXAMPLE - Order Flow' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

-- ── In-progress order: paid, awaiting pick/ship ───────────────────────────────
INSERT INTO in_progress_events
  (id, policy_id, aggregation_key, key_field, segment_count,
   cradle_segment_id, started_at, last_seen_at)
SELECT
  '1b000003-0000-0000-0000-000000000001'::uuid, p.id,
  'ORD-10047', 'orderId', 2,
  '5e000011-0000-0000-0000-000000000001'::uuid,
  now() - INTERVAL '2 hours',
  now() - INTERVAL '2 hours' + INTERVAL '3 minutes'
FROM policies p WHERE p.name = 'EXAMPLE - Order Flow' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

INSERT INTO event_segments
  (id, in_progress_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
SELECT s.id, '1b000003-0000-0000-0000-000000000001'::uuid, p.id,
  'ORD-10047', s.seq, s.cradle, s.grave, s.body::jsonb, now() - INTERVAL '2 hours' + s.dt 
FROM policies p,
(VALUES
  ('5e000011-0000-0000-0000-000000000001'::uuid, 1, TRUE,  FALSE, '{"eventType":"order.created","orderId":"ORD-10047","customerId":"cust-512","items":[{"sku":"WIDGET-A","qty":1,"price":24.99}],"total":24.99}', INTERVAL '0'),
  ('5e000011-0000-0000-0000-000000000002'::uuid, 2, FALSE, FALSE, '{"eventType":"order.payment","orderId":"ORD-10047","method":"card","amount":24.99,"reference":"PAY-99401"}',                                    INTERVAL '3 minutes')
) AS s(id, seq, cradle, grave, body, dt)
WHERE p.name = 'EXAMPLE - Order Flow' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;


-- =============================================================================
-- API REQUEST/RESPONSE -4 completed, 0 in-progress
-- =============================================================================

-- ── API pair 1: fast GET ───────────────────────────────────────────────────────
INSERT INTO completed_events
  (id, policy_id, aggregation_key, key_field, segment_count,
   cradle_segment_id, grave_segment_id, started_at, ended_at, completed_at)
SELECT
  'cc000009-0000-0000-0000-000000000001'::uuid, p.id,
  'req-A001', 'correlationId', 2,
  '5e000012-0000-0000-0000-000000000001'::uuid,
  '5e000012-0000-0000-0000-000000000002'::uuid,
  now() - INTERVAL '2 hours 30 minutes',
  now() - INTERVAL '2 hours 30 minutes' + INTERVAL '124 milliseconds',
  now() - INTERVAL '2 hours 30 minutes' + INTERVAL '124 milliseconds'
FROM policies p WHERE p.name = 'EXAMPLE - API Request/Response' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

INSERT INTO event_segments
  (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
SELECT s.id, 'cc000009-0000-0000-0000-000000000001'::uuid, p.id,
  'req-A001', s.seq, s.cradle, s.grave, s.body::jsonb, now() - INTERVAL '2 hours 30 minutes' + s.dt 
FROM policies p,
(VALUES
  ('5e000012-0000-0000-0000-000000000001'::uuid, 1, TRUE,  FALSE, '{"eventType":"api.request","correlationId":"req-A001","method":"GET","endpoint":"/api/v1/events","clientIp":"10.0.1.5","apiKey":"key-prod-01"}', INTERVAL '0'),
  ('5e000012-0000-0000-0000-000000000002'::uuid, 2, FALSE, TRUE,  '{"eventType":"api.response","correlationId":"req-A001","statusCode":200,"durationMs":124,"recordsReturned":50}',                                  INTERVAL '124 milliseconds')
) AS s(id, seq, cradle, grave, body, dt)
WHERE p.name = 'EXAMPLE - API Request/Response' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

-- ── API pair 2: POST ingest ────────────────────────────────────────────────────
INSERT INTO completed_events
  (id, policy_id, aggregation_key, key_field, segment_count,
   cradle_segment_id, grave_segment_id, started_at, ended_at, completed_at)
SELECT
  'cc000010-0000-0000-0000-000000000001'::uuid, p.id,
  'req-A002', 'correlationId', 2,
  '5e000013-0000-0000-0000-000000000001'::uuid,
  '5e000013-0000-0000-0000-000000000002'::uuid,
  now() - INTERVAL '1 hour 45 minutes',
  now() - INTERVAL '1 hour 45 minutes' + INTERVAL '38 milliseconds',
  now() - INTERVAL '1 hour 45 minutes' + INTERVAL '38 milliseconds'
FROM policies p WHERE p.name = 'EXAMPLE - API Request/Response' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

INSERT INTO event_segments
  (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
SELECT s.id, 'cc000010-0000-0000-0000-000000000001'::uuid, p.id,
  'req-A002', s.seq, s.cradle, s.grave, s.body::jsonb, now() - INTERVAL '1 hour 45 minutes' + s.dt 
FROM policies p,
(VALUES
  ('5e000013-0000-0000-0000-000000000001'::uuid, 1, TRUE,  FALSE, '{"eventType":"api.request","correlationId":"req-A002","method":"POST","endpoint":"/api/v1/events/ingest","clientIp":"10.0.1.5","apiKey":"key-prod-01"}', INTERVAL '0'),
  ('5e000013-0000-0000-0000-000000000002'::uuid, 2, FALSE, TRUE,  '{"eventType":"api.response","correlationId":"req-A002","statusCode":201,"durationMs":38,"action":"group_opened"}',                                       INTERVAL '38 milliseconds')
) AS s(id, seq, cradle, grave, body, dt)
WHERE p.name = 'EXAMPLE - API Request/Response' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

-- ── API pair 3: slow query ─────────────────────────────────────────────────────
INSERT INTO completed_events
  (id, policy_id, aggregation_key, key_field, segment_count,
   cradle_segment_id, grave_segment_id, started_at, ended_at, completed_at)
SELECT
  'cc000011-0000-0000-0000-000000000001'::uuid, p.id,
  'req-A003', 'correlationId', 2,
  '5e000014-0000-0000-0000-000000000001'::uuid,
  '5e000014-0000-0000-0000-000000000002'::uuid,
  now() - INTERVAL '55 minutes',
  now() - INTERVAL '55 minutes' + INTERVAL '1842 milliseconds',
  now() - INTERVAL '55 minutes' + INTERVAL '1842 milliseconds'
FROM policies p WHERE p.name = 'EXAMPLE - API Request/Response' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

INSERT INTO event_segments
  (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
SELECT s.id, 'cc000011-0000-0000-0000-000000000001'::uuid, p.id,
  'req-A003', s.seq, s.cradle, s.grave, s.body::jsonb, now() - INTERVAL '55 minutes' + s.dt 
FROM policies p,
(VALUES
  ('5e000014-0000-0000-0000-000000000001'::uuid, 1, TRUE,  FALSE, '{"eventType":"api.request","correlationId":"req-A003","method":"GET","endpoint":"/api/v1/events","clientIp":"10.0.2.18","queryParams":{"status":"all","limit":200}}', INTERVAL '0'),
  ('5e000014-0000-0000-0000-000000000002'::uuid, 2, FALSE, TRUE,  '{"eventType":"api.response","correlationId":"req-A003","statusCode":200,"durationMs":1842,"recordsReturned":200,"note":"slow response"}',                             INTERVAL '1842 milliseconds')
) AS s(id, seq, cradle, grave, body, dt)
WHERE p.name = 'EXAMPLE - API Request/Response' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

-- ── API pair 4: 404 not found ─────────────────────────────────────────────────
INSERT INTO completed_events
  (id, policy_id, aggregation_key, key_field, segment_count,
   cradle_segment_id, grave_segment_id, started_at, ended_at, completed_at)
SELECT
  'cc000012-0000-0000-0000-000000000001'::uuid, p.id,
  'req-A004', 'correlationId', 2,
  '5e000015-0000-0000-0000-000000000001'::uuid,
  '5e000015-0000-0000-0000-000000000002'::uuid,
  now() - INTERVAL '20 minutes',
  now() - INTERVAL '20 minutes' + INTERVAL '22 milliseconds',
  now() - INTERVAL '20 minutes' + INTERVAL '22 milliseconds'
FROM policies p WHERE p.name = 'EXAMPLE - API Request/Response' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;

INSERT INTO event_segments
  (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
SELECT s.id, 'cc000012-0000-0000-0000-000000000001'::uuid, p.id,
  'req-A004', s.seq, s.cradle, s.grave, s.body::jsonb, now() - INTERVAL '20 minutes' + s.dt 
FROM policies p,
(VALUES
  ('5e000015-0000-0000-0000-000000000001'::uuid, 1, TRUE,  FALSE, '{"eventType":"api.request","correlationId":"req-A004","method":"GET","endpoint":"/api/v1/events/non-existent-id","clientIp":"10.0.1.5","apiKey":"key-prod-01"}', INTERVAL '0'),
  ('5e000015-0000-0000-0000-000000000002'::uuid, 2, FALSE, TRUE,  '{"eventType":"api.response","correlationId":"req-A004","statusCode":404,"durationMs":22,"error":"Event group not found"}',                                       INTERVAL '22 milliseconds')
) AS s(id, seq, cradle, grave, body, dt)
WHERE p.name = 'EXAMPLE - API Request/Response' AND p.is_active = TRUE
ON CONFLICT DO NOTHING;


-- =============================================================================
-- Audit log
-- =============================================================================
INSERT INTO audit_log (entity_type, entity_id, action, aggregation_key, actor) VALUES
  ('event_group', 'cc000001-0000-0000-0000-000000000001', 'group.promoted', 'sess-U001-A', 'seed_script'),
  ('event_group', 'cc000002-0000-0000-0000-000000000001', 'group.promoted', 'sess-U002-B', 'seed_script'),
  ('event_group', 'cc000003-0000-0000-0000-000000000001', 'group.promoted', 'sess-U003-C', 'seed_script'),
  ('event_group', '1b000001-0000-0000-0000-000000000001', 'group.opened',   'sess-U004-D', 'seed_script'),
  ('event_group', 'cc000004-0000-0000-0000-000000000001', 'group.promoted', 'TRD-9001',    'seed_script'),
  ('event_group', 'cc000005-0000-0000-0000-000000000001', 'group.promoted', 'TRD-9002',    'seed_script'),
  ('event_group', 'cc000006-0000-0000-0000-000000000001', 'group.promoted', 'TRD-9003',    'seed_script'),
  ('event_group', '1b000002-0000-0000-0000-000000000001', 'group.opened',   'TRD-9004',    'seed_script'),
  ('event_group', 'cc000007-0000-0000-0000-000000000001', 'group.promoted', 'ORD-10045',   'seed_script'),
  ('event_group', 'cc000008-0000-0000-0000-000000000001', 'group.promoted', 'ORD-10046',   'seed_script'),
  ('event_group', '1b000003-0000-0000-0000-000000000001', 'group.opened',   'ORD-10047',   'seed_script'),
  ('event_group', 'cc000009-0000-0000-0000-000000000001', 'group.promoted', 'req-A001',    'seed_script'),
  ('event_group', 'cc000010-0000-0000-0000-000000000001', 'group.promoted', 'req-A002',    'seed_script'),
  ('event_group', 'cc000011-0000-0000-0000-000000000001', 'group.promoted', 'req-A003',    'seed_script'),
  ('event_group', 'cc000012-0000-0000-0000-000000000001', 'group.promoted', 'req-A004',    'seed_script');


-- =============================================================================
-- Verify
-- =============================================================================
SELECT
  p.name                                              AS policy,
  COUNT(DISTINCT ce.id)                               AS completed,
  COUNT(DISTINCT ip.id)                               AS in_progress,
  COUNT(DISTINCT ce.id) + COUNT(DISTINCT ip.id)       AS total
FROM policies p
LEFT JOIN completed_events   ce ON ce.policy_id = p.id
LEFT JOIN in_progress_events ip ON ip.policy_id = p.id
WHERE p.name LIKE 'EXAMPLE%'
GROUP BY p.name
ORDER BY p.name;
