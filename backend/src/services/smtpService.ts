import { query } from '../db/pool';
import { logger } from '../logger';
import { decryptSecret } from './secretBox';

export interface SmtpConfig {
  host:     string;
  port:     number;
  secure:   boolean;
  user:     string;
  password: string;
  from:     string;
}

export async function getSmtpConfig(): Promise<SmtpConfig | null> {
  try {
    const rows = await query<{ value: SmtpConfig }>(
      `SELECT value FROM system_config WHERE key = 'smtp'`
    );
    if (!rows.length) return null;
    const cfg = rows[0].value;
    return { ...cfg, password: decryptSecret(cfg.password ?? '') };
  } catch {
    return null;
  }
}

export async function sendGroupTimedOutAlert(group: {
  orgId: string;
  policyName: string;
  aggregationKey: string;
  timeoutMs: number;
  openedAt: Date;
}): Promise<void> {
  try {
    const cfg = await getSmtpConfig();
    if (!cfg?.host) return;

    // The timeout sweep runs under an RLS bypass, so the query must scope
    // admins explicitly: without this, a group in one org would email every
    // other org's admins too. Superadmins (org_id IS NULL) get all alerts.
    const adminRows = await query<{ email: string }>(
      `SELECT email FROM users
       WHERE role = 'admin' AND is_active = TRUE
         AND (org_id = $1 OR org_id IS NULL)`,
      [group.orgId]
    );
    if (!adminRows.length) return;

    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.default.createTransport({
      host:   cfg.host,
      port:   cfg.port,
      secure: cfg.secure,
      auth:   { user: cfg.user, pass: cfg.password },
    });

    const timeoutMinutes = Math.round(group.timeoutMs / 60000);
    const subject = `[Aggre/Gator] Group timed out -${group.policyName}`;
    const text = [
      `An event group has timed out without receiving a closing (grave) event.`,
      ``,
      `Policy:         ${group.policyName}`,
      `Aggregation Key: ${group.aggregationKey}`,
      `Opened At:      ${group.openedAt.toISOString()}`,
      `Timeout:        ${timeoutMinutes} minutes`,
      ``,
      `The group has been moved to completed events with close_reason = 'policy_timeout'.`,
    ].join('\n');

    await transporter.sendMail({
      from:    cfg.from || cfg.user,
      to:      adminRows.map(r => r.email).join(', '),
      subject,
      text,
    });
  } catch (err) {
    logger.error({ err }, '[smtp] Failed to send timeout alert');
  }
}
