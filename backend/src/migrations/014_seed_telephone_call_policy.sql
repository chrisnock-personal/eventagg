-- 014_seed_telephone_call_policy.sql
INSERT INTO policies (name, domain, key_field, cradle_field, cradle_value, grave_field, grave_value, timeout_ms, description)
VALUES (
    'DEMO - Telephone Call', 'call.*', 'callId',
    'eventType', 'call.invite',
    'eventType', 'call.ended',
    3600000,
    'SIP-style call lifecycle. Key from body.callId; opens on call.invite, closes on call.ended. 1h timeout for abandoned calls.'
)
ON CONFLICT DO NOTHING;
