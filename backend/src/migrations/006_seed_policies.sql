-- 006_seed_policies.sql
INSERT INTO policies (name, domain, key_field, cradle_field, cradle_value, grave_field, grave_value, description)
VALUES
    (
        'EXAMPLE - User Session', 'user.*', 'sessionId',
        'eventType', 'user.login',
        'eventType', 'user.logout',
        'Aggregates user session events. Key extracted from body.sessionId'
    ),
    (
        'EXAMPLE - Trade Lifecycle', 'trade.*', 'tradeRef',
        'eventType', 'trade.initiated',
        'status',    'settled',
        'Aggregates trade events. Key from body.tradeRef; closes when body.status = settled'
    ),
    (
        'EXAMPLE - Order Flow', 'order.*', 'orderId',
        'eventType', 'order.created',
        'eventType', 'order.delivered',
        'Aggregates order lifecycle. Key extracted from body.orderId'
    ),
    (
        'EXAMPLE - API Request/Response', 'api.*', 'correlationId',
        'eventType', 'api.request',
        'eventType', 'api.response',
        'Pairs API requests with responses. Key extracted from body.correlationId'
    )
ON CONFLICT DO NOTHING;
