-- 026_snmp_community_not_public.sql
-- Reversibility: data-only. The old value was the well-known 'public';
-- set it back with UPDATE ... SET snmp_community = 'public' if needed.
--
-- 025 gave the Default Organisation the community 'public'. The community
-- string is SNMPv2c's only credential, so replace it with a random one.
-- SNMP_COMMUNITY (env) still sets the Default Organisation's community at
-- boot if an operator wants a specific value (index.ts).
UPDATE organisations SET snmp_community = encode(gen_random_bytes(16), 'hex')
  WHERE snmp_community IN ('public', 'private');
