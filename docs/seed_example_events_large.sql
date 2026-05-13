-- seed_example_events.sql
-- Generates ~5000 event groups across the four EXAMPLE policies.
-- Safe to re-run: skips groups whose aggregation_key already exists for that policy.
--
-- Distribution:
--   User Session          ~1800 groups  (3-4 segments each)
--   Trade Lifecycle        ~900 groups  (3-5 segments each)
--   Order Flow             ~700 groups  (4-6 segments each)
--   API Request/Response  ~1600 groups  (2 segments each, very fast)
--   Total                 ~5000 groups, ~16 000 segments
--
-- Timestamps span the last 90 days so date-range filters are exercised.
-- ~8% of groups are left in_progress (no grave segment inserted).

DO $$
DECLARE
  pol_session   UUID;
  pol_trade     UUID;
  pol_order     UUID;
  pol_api       UUID;

  -- counters
  i             INT;
  n_segs        INT;
  seg_idx       INT;

  -- timing
  group_start   TIMESTAMPTZ;
  seg_ts        TIMESTAMPTZ;
  dur_secs      INT;
  gap_secs      INT;

  -- identifiers
  agg_key       TEXT;
  group_id      UUID;
  completed_id  UUID;
  cradle_seg_id UUID;
  grave_seg_id  UUID;
  seg_id        UUID;

  -- body fragments
  symbol        TEXT;
  trader        TEXT;
  side          TEXT;
  qty           INT;
  price         NUMERIC(10,2);
  status_val    TEXT;
  user_id       TEXT;
  ip_addr       TEXT;
  cust_id       TEXT;
  carrier       TEXT;
  method        TEXT;
  endpoint      TEXT;
  http_status   INT;
  resp_ms       INT;

  -- arrays for variety
  symbols       TEXT[] := ARRAY['AAPL','MSFT','GOOGL','AMZN','TSLA','NVDA','META','NFLX','BRK.B','JPM',
                                 'GBP/USD','EUR/USD','USD/JPY','AUD/USD','GBP/EUR',
                                 'GOLD','OIL','BTC/USD','ETH/USD','SPX'];
  traders       TEXT[] := ARRAY['t-smith','t-jones','t-patel','t-chen','t-garcia','t-mueller',
                                 't-okafor','t-lee','t-russo','t-novak'];
  carriers      TEXT[] := ARRAY['DHL','FedEx','UPS','Royal Mail','Hermes','DPD','Yodel'];
  methods       TEXT[] := ARRAY['GET','POST','PUT','PATCH','DELETE'];
  endpoints     TEXT[] := ARRAY['/api/v1/events','/api/v1/policies','/api/v1/events/ingest',
                                 '/api/v1/events/{id}','/api/v1/policies/{id}',
                                 '/api/v1/events/{id}/segments','/health'];

BEGIN

  -- Resolve policy UUIDs by name
  SELECT id INTO pol_session FROM policies WHERE name = 'EXAMPLE - User Session'         LIMIT 1;
  SELECT id INTO pol_trade   FROM policies WHERE name = 'EXAMPLE - Trade Lifecycle'      LIMIT 1;
  SELECT id INTO pol_order   FROM policies WHERE name = 'EXAMPLE - Order Flow'           LIMIT 1;
  SELECT id INTO pol_api     FROM policies WHERE name = 'EXAMPLE - API Request/Response' LIMIT 1;

  IF pol_session IS NULL OR pol_trade IS NULL OR pol_order IS NULL OR pol_api IS NULL THEN
    RAISE EXCEPTION 'EXAMPLE policies not found — run migrations first (006_seed_policies.sql)';
  END IF;

  -- ══════════════════════════════════════════════════════════════════════════
  -- 1. USER SESSION  (1800 groups, ~3-4 segments, sessions 2-45 min)
  -- ══════════════════════════════════════════════════════════════════════════
  FOR i IN 1..1800 LOOP
    agg_key     := 'sess-U' || LPAD((100 + (i % 500))::TEXT, 3, '0') || '-' || CHR(65 + (i % 26));
    group_start := NOW() - (RANDOM() * INTERVAL '90 days') - (RANDOM() * INTERVAL '23 hours');
    dur_secs    := (120 + FLOOR(RANDOM() * 2580))::INT;   -- 2 min – 45 min
    user_id     := 'usr-' || LPAD((1 + (i % 500))::TEXT, 3, '0');
    ip_addr     := (10 + (i % 245))::TEXT || '.' || (i % 255)::TEXT || '.' || (i % 200)::TEXT || '.1';

    -- Skip if already exists
    IF EXISTS (SELECT 1 FROM completed_events  WHERE policy_id = pol_session AND aggregation_key = agg_key)
       OR EXISTS (SELECT 1 FROM in_progress_events WHERE policy_id = pol_session AND aggregation_key = agg_key)
    THEN CONTINUE; END IF;

    group_id     := gen_random_uuid();
    cradle_seg_id := gen_random_uuid();
    n_segs       := 3 + (i % 2);  -- 3 or 4 segments

    IF i % 13 = 0 THEN
      -- ~8%: leave in_progress
      INSERT INTO in_progress_events (id, policy_id, aggregation_key, key_field, segment_count, cradle_segment_id, started_at, last_seen_at)
      VALUES (group_id, pol_session, agg_key, 'sessionId', 1, cradle_seg_id, group_start, group_start);

      INSERT INTO event_segments (id, in_progress_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
      VALUES (cradle_seg_id, group_id, pol_session, agg_key, 1, TRUE, FALSE,
        jsonb_build_object('eventType','user.login','sessionId',agg_key,'userId',user_id,'ipAddress',ip_addr),
        group_start);

      FOR seg_idx IN 2..n_segs-1 LOOP
        seg_ts := group_start + ((seg_idx-1) * (dur_secs / n_segs) * INTERVAL '1 second');
        INSERT INTO event_segments (id, in_progress_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
        VALUES (gen_random_uuid(), group_id, pol_session, agg_key, seg_idx, FALSE, FALSE,
          jsonb_build_object('eventType','user.action','sessionId',agg_key,'action',
            CASE seg_idx % 5 WHEN 0 THEN 'view_dashboard' WHEN 1 THEN 'search' WHEN 2 THEN 'view_report'
              WHEN 3 THEN 'export_data' ELSE 'update_settings' END),
          seg_ts);
      END LOOP;

      UPDATE in_progress_events SET segment_count = n_segs - 1, last_seen_at = group_start + (dur_secs * 0.5 * INTERVAL '1 second')
      WHERE id = group_id;

    ELSE
      -- Completed session
      grave_seg_id  := gen_random_uuid();
      completed_id  := gen_random_uuid();

      INSERT INTO completed_events (id, policy_id, aggregation_key, key_field, segment_count, cradle_segment_id, grave_segment_id, started_at, ended_at, completed_at)
      VALUES (completed_id, pol_session, agg_key, 'sessionId', n_segs, cradle_seg_id, grave_seg_id,
        group_start, group_start + (dur_secs * INTERVAL '1 second'),
        group_start + (dur_secs * INTERVAL '1 second'));

      INSERT INTO event_segments (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
      VALUES (cradle_seg_id, completed_id, pol_session, agg_key, 1, TRUE, FALSE,
        jsonb_build_object('eventType','user.login','sessionId',agg_key,'userId',user_id,'ipAddress',ip_addr),
        group_start);

      FOR seg_idx IN 2..n_segs-1 LOOP
        seg_ts := group_start + ((seg_idx-1) * (dur_secs / n_segs) * INTERVAL '1 second');
        INSERT INTO event_segments (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
        VALUES (gen_random_uuid(), completed_id, pol_session, agg_key, seg_idx, FALSE, FALSE,
          jsonb_build_object('eventType','user.action','sessionId',agg_key,'action',
            CASE seg_idx % 5 WHEN 0 THEN 'view_dashboard' WHEN 1 THEN 'search' WHEN 2 THEN 'view_report'
              WHEN 3 THEN 'export_data' ELSE 'update_settings' END),
          seg_ts);
      END LOOP;

      INSERT INTO event_segments (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
      VALUES (grave_seg_id, completed_id, pol_session, agg_key, n_segs, FALSE, TRUE,
        jsonb_build_object('eventType','user.logout','sessionId',agg_key,'userId',user_id,
          'reason', CASE i % 3 WHEN 0 THEN 'explicit' WHEN 1 THEN 'timeout' ELSE 'session_expired' END),
        group_start + (dur_secs * INTERVAL '1 second'));
    END IF;

  END LOOP;

  -- ══════════════════════════════════════════════════════════════════════════
  -- 2. TRADE LIFECYCLE  (900 groups, 3-5 segments, minutes to days)
  -- ══════════════════════════════════════════════════════════════════════════
  FOR i IN 1..900 LOOP
    agg_key     := 'TRD-' || LPAD((1000 + i)::TEXT, 6, '0');
    group_start := NOW() - (RANDOM() * INTERVAL '90 days');
    dur_secs    := (300 + FLOOR(RANDOM() * 172500))::INT;  -- 5 min – 2 days
    symbol      := symbols[1 + (i % ARRAY_LENGTH(symbols,1))];
    trader      := traders[1 + (i % ARRAY_LENGTH(traders,1))];
    side        := CASE WHEN i % 2 = 0 THEN 'BUY' ELSE 'SELL' END;
    qty         := (100 + (i % 9900))::INT;
    price       := (10.00 + (RANDOM() * 990))::NUMERIC(10,2);
    n_segs      := 3 + (i % 3);  -- 3, 4, or 5 segments

    IF EXISTS (SELECT 1 FROM completed_events  WHERE policy_id = pol_trade AND aggregation_key = agg_key)
       OR EXISTS (SELECT 1 FROM in_progress_events WHERE policy_id = pol_trade AND aggregation_key = agg_key)
    THEN CONTINUE; END IF;

    group_id      := gen_random_uuid();
    cradle_seg_id := gen_random_uuid();

    IF i % 12 = 0 THEN
      -- ~8%: in_progress trade
      INSERT INTO in_progress_events (id, policy_id, aggregation_key, key_field, segment_count, cradle_segment_id, started_at, last_seen_at)
      VALUES (group_id, pol_trade, agg_key, 'tradeRef', 1, cradle_seg_id, group_start, group_start);

      INSERT INTO event_segments (id, in_progress_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
      VALUES (cradle_seg_id, group_id, pol_trade, agg_key, 1, TRUE, FALSE,
        jsonb_build_object('eventType','trade.initiated','tradeRef',agg_key,'symbol',symbol,
          'side',side,'qty',qty,'price',price,'trader',trader),
        group_start);

      UPDATE in_progress_events SET segment_count = 1, last_seen_at = group_start WHERE id = group_id;

    ELSE
      -- Completed trade
      grave_seg_id := gen_random_uuid();
      completed_id := gen_random_uuid();

      INSERT INTO completed_events (id, policy_id, aggregation_key, key_field, segment_count, cradle_segment_id, grave_segment_id, started_at, ended_at, completed_at)
      VALUES (completed_id, pol_trade, agg_key, 'tradeRef', n_segs, cradle_seg_id, grave_seg_id,
        group_start, group_start + (dur_secs * INTERVAL '1 second'),
        group_start + (dur_secs * INTERVAL '1 second'));

      INSERT INTO event_segments (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
      VALUES (cradle_seg_id, completed_id, pol_trade, agg_key, 1, TRUE, FALSE,
        jsonb_build_object('eventType','trade.initiated','tradeRef',agg_key,'symbol',symbol,
          'side',side,'qty',qty,'price',price,'trader',trader),
        group_start);

      -- Middle segments: confirmed, clearing, risk check etc
      FOR seg_idx IN 2..n_segs-1 LOOP
        gap_secs := (dur_secs / n_segs) * (seg_idx - 1);
        seg_ts   := group_start + (gap_secs * INTERVAL '1 second');
        INSERT INTO event_segments (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
        VALUES (gen_random_uuid(), completed_id, pol_trade, agg_key, seg_idx, FALSE, FALSE,
          CASE seg_idx
            WHEN 2 THEN jsonb_build_object('eventType','trade.confirmed','tradeRef',agg_key,
              'exchangeRef','EX-' || LPAD(i::TEXT,5,'0'),'confirmedAt',seg_ts)
            WHEN 3 THEN jsonb_build_object('eventType','trade.clearing','tradeRef',agg_key,
              'clearingRef','CLR-' || LPAD(i::TEXT,5,'0'),'clearingHouse',
              CASE i % 3 WHEN 0 THEN 'LCH' WHEN 1 THEN 'ICE' ELSE 'CME' END)
            ELSE jsonb_build_object('eventType','trade.risk_check','tradeRef',agg_key,
              'riskScore', (RANDOM() * 100)::INT, 'approved', TRUE)
          END,
          seg_ts);
      END LOOP;

      INSERT INTO event_segments (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
      VALUES (grave_seg_id, completed_id, pol_trade, agg_key, n_segs, FALSE, TRUE,
        jsonb_build_object('eventType','trade.settled','tradeRef',agg_key,
          'status','settled','netAmount',(qty * price)::NUMERIC(14,2),
          'settlementDate',(group_start + (dur_secs * INTERVAL '1 second'))::DATE),
        group_start + (dur_secs * INTERVAL '1 second'));
    END IF;

  END LOOP;

  -- ══════════════════════════════════════════════════════════════════════════
  -- 3. ORDER FLOW  (700 groups, 4-6 segments, hours to days)
  -- ══════════════════════════════════════════════════════════════════════════
  FOR i IN 1..700 LOOP
    agg_key     := 'ORD-' || LPAD((10000 + i)::TEXT, 6, '0');
    group_start := NOW() - (RANDOM() * INTERVAL '90 days');
    dur_secs    := (3600 + FLOOR(RANDOM() * 345600))::INT;  -- 1h – 4 days
    cust_id     := 'cust-' || LPAD((1 + (i % 1000))::TEXT, 4, '0');
    carrier     := carriers[1 + (i % ARRAY_LENGTH(carriers,1))];
    n_segs      := 4 + (i % 3);  -- 4, 5, or 6 segments

    IF EXISTS (SELECT 1 FROM completed_events  WHERE policy_id = pol_order AND aggregation_key = agg_key)
       OR EXISTS (SELECT 1 FROM in_progress_events WHERE policy_id = pol_order AND aggregation_key = agg_key)
    THEN CONTINUE; END IF;

    group_id      := gen_random_uuid();
    cradle_seg_id := gen_random_uuid();

    IF i % 11 = 0 THEN
      -- ~9%: in_progress orders
      INSERT INTO in_progress_events (id, policy_id, aggregation_key, key_field, segment_count, cradle_segment_id, started_at, last_seen_at)
      VALUES (group_id, pol_order, agg_key, 'orderId', 2, cradle_seg_id, group_start, group_start + INTERVAL '5 minutes');

      INSERT INTO event_segments (id, in_progress_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
      VALUES (cradle_seg_id, group_id, pol_order, agg_key, 1, TRUE, FALSE,
        jsonb_build_object('eventType','order.created','orderId',agg_key,'customerId',cust_id,
          'total',(9.99 + (RANDOM() * 990))::NUMERIC(8,2),'items',n_segs - 1),
        group_start);

      INSERT INTO event_segments (id, in_progress_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
      VALUES (gen_random_uuid(), group_id, pol_order, agg_key, 2, FALSE, FALSE,
        jsonb_build_object('eventType','order.payment','orderId',agg_key,'method',
          CASE i % 3 WHEN 0 THEN 'card' WHEN 1 THEN 'paypal' ELSE 'bank_transfer' END,
          'status','approved'),
        group_start + INTERVAL '5 minutes');

      UPDATE in_progress_events SET segment_count = 2, last_seen_at = group_start + INTERVAL '5 minutes'
      WHERE id = group_id;

    ELSE
      -- Completed order
      grave_seg_id := gen_random_uuid();
      completed_id := gen_random_uuid();

      INSERT INTO completed_events (id, policy_id, aggregation_key, key_field, segment_count, cradle_segment_id, grave_segment_id, started_at, ended_at, completed_at)
      VALUES (completed_id, pol_order, agg_key, 'orderId', n_segs, cradle_seg_id, grave_seg_id,
        group_start, group_start + (dur_secs * INTERVAL '1 second'),
        group_start + (dur_secs * INTERVAL '1 second'));

      INSERT INTO event_segments (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
      VALUES (cradle_seg_id, completed_id, pol_order, agg_key, 1, TRUE, FALSE,
        jsonb_build_object('eventType','order.created','orderId',agg_key,'customerId',cust_id,
          'total',(9.99 + (RANDOM() * 990))::NUMERIC(8,2)),
        group_start);

      INSERT INTO event_segments (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
      VALUES (gen_random_uuid(), completed_id, pol_order, agg_key, 2, FALSE, FALSE,
        jsonb_build_object('eventType','order.payment','orderId',agg_key,'method',
          CASE i % 3 WHEN 0 THEN 'card' WHEN 1 THEN 'paypal' ELSE 'bank_transfer' END,
          'status','approved','amount',(9.99 + RANDOM() * 990)::NUMERIC(8,2)),
        group_start + (dur_secs * 0.02 * INTERVAL '1 second'));

      INSERT INTO event_segments (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
      VALUES (gen_random_uuid(), completed_id, pol_order, agg_key, 3, FALSE, FALSE,
        jsonb_build_object('eventType','order.picked','orderId',agg_key,
          'warehouseId','WH-' || LPAD((1 + i % 10)::TEXT,2,'0'),
          'pickedBy','staff-' || LPAD((i % 50)::TEXT,2,'0')),
        group_start + (dur_secs * 0.3 * INTERVAL '1 second'));

      IF n_segs >= 5 THEN
        INSERT INTO event_segments (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
        VALUES (gen_random_uuid(), completed_id, pol_order, agg_key, 4, FALSE, FALSE,
          jsonb_build_object('eventType','order.shipped','orderId',agg_key,'carrier',carrier,
            'trackingRef',carrier || '-' || LPAD(i::TEXT,8,'0')),
          group_start + (dur_secs * 0.5 * INTERVAL '1 second'));
      END IF;

      IF n_segs = 6 THEN
        INSERT INTO event_segments (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
        VALUES (gen_random_uuid(), completed_id, pol_order, agg_key, n_segs - 1, FALSE, FALSE,
          jsonb_build_object('eventType','order.out_for_delivery','orderId',agg_key,'carrier',carrier),
          group_start + (dur_secs * 0.85 * INTERVAL '1 second'));
      END IF;

      INSERT INTO event_segments (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
      VALUES (grave_seg_id, completed_id, pol_order, agg_key, n_segs, FALSE, TRUE,
        jsonb_build_object('eventType','order.delivered','orderId',agg_key,
          'signedBy',CASE i % 5 WHEN 0 THEN 'J.Smith' WHEN 1 THEN 'A.Jones' WHEN 2 THEN 'neighbour'
            WHEN 3 THEN 'safe_place' ELSE 'reception' END,
          'carrier',carrier),
        group_start + (dur_secs * INTERVAL '1 second'));
    END IF;

  END LOOP;

  -- ══════════════════════════════════════════════════════════════════════════
  -- 4. API REQUEST/RESPONSE  (1600 groups, always 2 segments, ms-to-seconds)
  -- ══════════════════════════════════════════════════════════════════════════
  FOR i IN 1..1600 LOOP
    agg_key     := 'req-' || LPAD(i::TEXT, 6, '0');
    group_start := NOW() - (RANDOM() * INTERVAL '90 days');
    resp_ms     := CASE
                     WHEN i % 20 = 0 THEN 2000 + (RANDOM() * 8000)::INT   -- 10% slow (2-10s)
                     WHEN i % 5  = 0 THEN 500  + (RANDOM() * 1500)::INT   -- 20% medium (0.5-2s)
                     ELSE                  20   + (RANDOM() * 480)::INT    -- 70% fast (20-500ms)
                   END;
    dur_secs    := GREATEST(1, resp_ms / 1000);
    method      := methods[1 + (i % ARRAY_LENGTH(methods,1))];
    endpoint    := endpoints[1 + (i % ARRAY_LENGTH(endpoints,1))];
    http_status := CASE
                     WHEN i % 50 = 0 THEN 500
                     WHEN i % 20 = 0 THEN 404
                     WHEN i % 10 = 0 THEN 400
                     ELSE 200
                   END;

    IF EXISTS (SELECT 1 FROM completed_events  WHERE policy_id = pol_api AND aggregation_key = agg_key)
       OR EXISTS (SELECT 1 FROM in_progress_events WHERE policy_id = pol_api AND aggregation_key = agg_key)
    THEN CONTINUE; END IF;

    group_id      := gen_random_uuid();
    cradle_seg_id := gen_random_uuid();

    IF i % 15 = 0 THEN
      -- ~7%: timed-out requests (no response received)
      INSERT INTO in_progress_events (id, policy_id, aggregation_key, key_field, segment_count, cradle_segment_id, started_at, last_seen_at)
      VALUES (group_id, pol_api, agg_key, 'correlationId', 1, cradle_seg_id, group_start, group_start);

      INSERT INTO event_segments (id, in_progress_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
      VALUES (cradle_seg_id, group_id, pol_api, agg_key, 1, TRUE, FALSE,
        jsonb_build_object('eventType','api.request','correlationId',agg_key,
          'method',method,'endpoint',endpoint),
        group_start);

    ELSE
      -- Completed pair
      grave_seg_id := gen_random_uuid();
      completed_id := gen_random_uuid();

      INSERT INTO completed_events (id, policy_id, aggregation_key, key_field, segment_count, cradle_segment_id, grave_segment_id, started_at, ended_at, completed_at)
      VALUES (completed_id, pol_api, agg_key, 'correlationId', 2, cradle_seg_id, grave_seg_id,
        group_start, group_start + (resp_ms * INTERVAL '1 millisecond'),
        group_start + (resp_ms * INTERVAL '1 millisecond'));

      INSERT INTO event_segments (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
      VALUES (cradle_seg_id, completed_id, pol_api, agg_key, 1, TRUE, FALSE,
        jsonb_build_object('eventType','api.request','correlationId',agg_key,
          'method',method,'endpoint',endpoint,
          'userAgent',CASE i % 4 WHEN 0 THEN 'EventAgg-Client/1.0' WHEN 1 THEN 'curl/8.1.0'
            WHEN 2 THEN 'Python/requests' ELSE 'node-fetch' END),
        group_start);

      INSERT INTO event_segments (id, completed_id, policy_id, aggregation_key, sequence, is_cradle, is_grave, body, received_at)
      VALUES (grave_seg_id, completed_id, pol_api, agg_key, 2, FALSE, TRUE,
        jsonb_build_object('eventType','api.response','correlationId',agg_key,
          'statusCode',http_status,'durationMs',resp_ms,
          'responseSize',(200 + (RANDOM() * 50000))::INT),
        group_start + (resp_ms * INTERVAL '1 millisecond'));
    END IF;

  END LOOP;

  RAISE NOTICE 'Seed complete. Run SELECT count(*) FROM completed_events; to verify.';

END $$;
