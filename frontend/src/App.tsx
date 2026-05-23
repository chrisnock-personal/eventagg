import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  api,
  Policy,
  EventGroupSummary,
  EventGroupDetail,
  SegmentDetail,
  IngestResult,
  EventStats,
} from "./api";

// ─── Palette ──────────────────────────────────────────────────────────────────
const C = {
  bg: "#F8F7F4", surface: "#FFFFFF", surfaceAlt: "#F2F1EE", surfaceDeep: "#ECEAE6",
  border: "#E0DDD8", borderStrong: "#C8C4BC",
  text: "#1A1916", textMid: "#4A4844", textMuted: "#8A8680",
  accent: "#1D6B4E", accentLight: "#E8F3EE", accentSoft: "#B8DCC9",
  warn: "#B45309", warnLight: "#FEF3C7",
  danger: "#991B1B", dangerLight: "#FEE2E2",
  info: "#1D4ED8", infoLight: "#DBEAFE",
  purple: "#6D28D9", purpleLight: "#EDE9FE",
  timeout: "#C2410C", timeoutLight: "#FFF7ED", timeoutSoft: "#FED7AA",
};

// ─── Column definitions ───────────────────────────────────────────────────────
interface ColDef { key: string; label: string; defaultWidth: number; minWidth: number; }

const GROUP_COLS: ColDef[] = [
  { key: "id",        label: "Event Group ID",  defaultWidth: 175, minWidth: 120 },
  { key: "policy",    label: "Policy",          defaultWidth: 195, minWidth: 120 },
  { key: "key",       label: "Aggregation Key", defaultWidth: 140, minWidth: 90  },
  { key: "source",    label: "Source",          defaultWidth: 155, minWidth: 100 },
  { key: "status",    label: "Status",          defaultWidth: 145, minWidth: 100 },
  { key: "startTime", label: "Start Time",      defaultWidth: 155, minWidth: 120 },
  { key: "segs",      label: "Segs",            defaultWidth: 52,  minWidth: 40  },
  { key: "_arrow",    label: "",                defaultWidth: 36,  minWidth: 36  },
];

const SEG_COLS: ColDef[] = [
  { key: "id",         label: "Segment ID",      defaultWidth: 175, minWidth: 120 },
  { key: "groupId",    label: "Event Group ID",   defaultWidth: 160, minWidth: 120 },
  { key: "policy",     label: "Policy",           defaultWidth: 195, minWidth: 120 },
  { key: "aggKey",     label: "Aggregation Key",  defaultWidth: 130, minWidth: 90  },
  { key: "seq",        label: "Seq",              defaultWidth: 50,  minWidth: 40  },
  { key: "type",       label: "Event Type",       defaultWidth: 165, minWidth: 100 },
  { key: "cradle",     label: "Cradle",           defaultWidth: 80,  minWidth: 60  },
  { key: "grave",      label: "Grave",            defaultWidth: 80,  minWidth: 60  },
  { key: "receivedAt", label: "Received At",      defaultWidth: 155, minWidth: 120 },
  { key: "_arrow",     label: "",                 defaultWidth: 36,  minWidth: 36  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "medium" }) : "—";

function fmtDur(startTime: string, endTime: string | null): string {
  if (!endTime) return "ongoing";
  const s = Math.round((new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((cur, k) =>
    cur !== null && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined, obj);
}

// ─── Shared UI ────────────────────────────────────────────────────────────────
function Badge({ label, bg, color }: { label: string; bg: string; color: string }) {
  return <span style={{ background: bg, color, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", fontFamily: "monospace" }}>{label}</span>;
}
function StatusBadge({ status }: { status: string }) {
  if (status === "completed")   return <Badge label="● Completed"   bg={C.accentLight}   color={C.accent}  />;
  if (status === "timed_out")   return <Badge label="⏱ Timed Out"   bg={C.timeoutLight}  color={C.timeout} />;
  return <Badge label="◐ In Progress" bg={C.warnLight} color={C.warn} />;
}
function BoolBadge({ val, trueLabel, trueColor }: { val: boolean; trueLabel: string; trueColor: string }) {
  return val
    ? <span style={{ background: trueColor + "18", color: trueColor, padding: "1px 7px", borderRadius: 3, fontSize: 10, fontWeight: 700, fontFamily: "monospace", border: `1px solid ${trueColor}30` }}>{trueLabel}</span>
    : <span style={{ color: C.textMuted, fontSize: 11 }}>—</span>;
}
function CopyableId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); });
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 5 }}>
      <code style={{ fontSize: 10, fontFamily: "monospace", color: C.textMuted }}>{id}</code>
      <button onClick={copy} style={{ background: copied ? C.accentLight : C.surface, border: `1px solid ${copied ? C.accentSoft : C.border}`, borderRadius: 4, padding: "1px 6px", fontSize: 10, fontFamily: "inherit", color: copied ? C.accent : C.textMuted, cursor: "pointer", fontWeight: 600, transition: "all 0.15s", flexShrink: 0 }}>
        {copied ? "✓ copied" : "copy"}
      </button>
    </div>
  );
}
function ConditionPill({ label, field, value, color }: { label: string; field: string; value?: string; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 20, background: color + "15", border: `1px solid ${color}35`, fontSize: 11, flexShrink: 0 }}>
      <span style={{ color: C.textMuted, fontWeight: 600, fontSize: 10 }}>{label}</span>
      <span style={{ fontFamily: "monospace", color: C.textMid }}>{field}</span>
      {value !== undefined && (<><span style={{ color: C.textMuted, fontSize: 10 }}>=</span><span style={{ fontFamily: "monospace", color, fontWeight: 700 }}>"{value}"</span></>)}
    </div>
  );
}
function FInput({ label, value, onChange, placeholder, mono = false, style: sx = {} }: {
  label?: string; value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean; style?: React.CSSProperties;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1 }}>
      {label && <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: C.textMuted, textTransform: "uppercase" }}>{label}</span>}
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{ border: `1px solid ${C.border}`, borderRadius: 5, padding: "6px 10px", fontSize: 12, color: C.text, background: C.surface, outline: "none", fontFamily: mono ? "'Courier New', monospace" : "inherit", width: "100%", boxSizing: "border-box", ...sx }} />
    </label>
  );
}
function FSelect({ label, value, onChange, options }: {
  label?: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1 }}>
      {label && <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: C.textMuted, textTransform: "uppercase" }}>{label}</span>}
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ border: `1px solid ${C.border}`, borderRadius: 5, padding: "6px 10px", fontSize: 12, color: C.text, background: C.surface, outline: "none", fontFamily: "inherit", appearance: "none", cursor: "pointer" }}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}
function Btn({ label, onClick, variant = "ghost", small }: { label: string; onClick: () => void; variant?: "primary" | "ghost" | "danger"; small?: boolean }) {
  const variants: Record<string, React.CSSProperties> = {
    primary: { background: C.accent, color: "#fff", border: "none" },
    ghost:   { background: C.surface, color: C.textMid, border: `1px solid ${C.border}` },
    danger:  { background: C.dangerLight, color: C.danger, border: "1px solid #FCA5A5" },
  };
  return <button onClick={onClick} style={{ borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontWeight: 600, padding: small ? "5px 12px" : "7px 16px", fontSize: small ? 11 : 12, ...variants[variant] }}>{label}</button>;
}
function SectionLabel({ text }: { text: string }) {
  return <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.09em", color: C.textMuted, textTransform: "uppercase", marginBottom: 8 }}>{text}</div>;
}

// ─── Column Visibility Dropdown ───────────────────────────────────────────────
function ColVisMenu({ cols, visible, onToggle, onClose }: {
  cols: ColDef[]; visible: Set<string>; onToggle: (k: string) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [onClose]);
  return (
    <div ref={ref} style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.12)", zIndex: 50, minWidth: 210, padding: "6px 0" }}>
      <div style={{ padding: "6px 14px 4px", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: C.textMuted, textTransform: "uppercase" }}>Show / Hide Columns</div>
      {cols.filter(c => !c.key.startsWith("_")).map(col => (
        <label key={col.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 14px", cursor: "pointer", fontSize: 12, color: C.text }}
          onMouseEnter={e => (e.currentTarget.style.background = C.surfaceAlt)}
          onMouseLeave={e => (e.currentTarget.style.background = "")}>
          <input type="checkbox" checked={visible.has(col.key)} onChange={() => onToggle(col.key)} style={{ accentColor: C.accent, width: 13, height: 13 }} />
          {col.label}
        </label>
      ))}
    </div>
  );
}

// ─── Resizable Table Header ───────────────────────────────────────────────────
function ResizableTh({ col, widths, setWidths, isLast }: {
  col: ColDef; widths: Record<string, number>; setWidths: React.Dispatch<React.SetStateAction<Record<string, number>>>; isLast: boolean;
}) {
  const thRef = useRef<HTMLTableCellElement>(null);
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widths[col.key] ?? col.defaultWidth;
    const onMove = (ev: MouseEvent) => {
      setWidths(w => ({ ...w, [col.key]: Math.max(col.minWidth, startW + ev.clientX - startX) }));
    };
    const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  return (
    <th ref={thRef} style={{ padding: "7px 10px", textAlign: "left", fontSize: 10, fontWeight: 700, letterSpacing: "0.07em", color: C.textMuted, textTransform: "uppercase", whiteSpace: "nowrap", borderBottom: `1px solid ${C.border}`, position: "relative", userSelect: "none" }}>
      {col.label}
      {!isLast && !col.key.startsWith("_") && (
        <div onMouseDown={onMouseDown} style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 6, cursor: "col-resize", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 1, height: "55%", background: C.borderStrong }} />
        </div>
      )}
    </th>
  );
}

// ─── Policy form ──────────────────────────────────────────────────────────────
interface PolicyForm {
  id?: string; name: string; domain: string; keyField: string;
  cradleField: string; cradleValue: string; graveField: string; graveValue: string;
  description: string; timeoutMs: number | null;
}
const blankPolicy = (): PolicyForm => ({ name: "", domain: "*", keyField: "", cradleField: "eventType", cradleValue: "", graveField: "eventType", graveValue: "", description: "", timeoutMs: null });

// ─── Duration Input ───────────────────────────────────────────────────────────
function DurationInput({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const [enabled, setEnabled] = useState(value !== null);
  const [amount,  setAmount]  = useState(() => {
    if (!value) return 24;
    if (value >= 86400000) return Math.round(value / 86400000);
    if (value >= 3600000)  return Math.round(value / 3600000);
    return Math.round(value / 60000);
  });
  const [unit, setUnit] = useState<"minutes"|"hours"|"days">(() => {
    if (!value) return "hours";
    if (value >= 86400000) return "days";
    if (value >= 3600000)  return "hours";
    return "minutes";
  });
  const unitMs = { minutes: 60000, hours: 3600000, days: 86400000 } as const;

  function toggle(v: boolean) { setEnabled(v); onChange(v ? Math.round(amount) * unitMs[unit] : null); }
  function changeAmount(v: number) { const n = Math.max(1, Math.round(v)); setAmount(n); if (enabled) onChange(n * unitMs[unit]); }
  function changeUnit(v: "minutes"|"hours"|"days") { setUnit(v); if (enabled) onChange(Math.round(amount) * unitMs[v]); }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button onClick={() => toggle(!enabled)} style={{ position: "relative", width: 36, height: 20, borderRadius: 10, border: "none", background: enabled ? C.timeout : C.borderStrong, cursor: "pointer", padding: 0, flexShrink: 0 }}>
          <div style={{ position: "absolute", top: 2, left: enabled ? 18 : 2, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
        </button>
        <span style={{ fontSize: 12, color: enabled ? C.text : C.textMuted }}>{enabled ? "Close group after" : "No timeout (manual grave only)"}</span>
      </div>
      {enabled && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", paddingLeft: 46 }}>
          <input type="number" min="1" value={amount} onChange={e => changeAmount(Number(e.target.value))}
            style={{ width: 64, padding: "5px 8px", border: `1px solid ${C.border}`, borderRadius: 5, fontSize: 12, fontFamily: "monospace", color: C.text, background: C.surface, outline: "none" }} />
          <select value={unit} onChange={e => changeUnit(e.target.value as "minutes"|"hours"|"days")}
            style={{ padding: "5px 8px", border: `1px solid ${C.border}`, borderRadius: 5, fontSize: 12, fontFamily: "inherit", color: C.textMid, background: C.surface, outline: "none" }}>
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
            <option value="days">days</option>
          </select>
          <span style={{ fontSize: 11, color: C.textMuted }}>since last segment received</span>
        </div>
      )}
      {enabled && (
        <div style={{ paddingLeft: 46, fontSize: 10, color: C.textMuted, lineHeight: 1.5 }}>
          Clock starts at cradle and resets on each new segment. Group is promoted to <code style={{ fontFamily: "monospace" }}>timed_out</code> when no segment arrives within this window.
        </div>
      )}
    </div>
  );
}

// ─── Policy Editor ────────────────────────────────────────────────────────────
function PolicyEditor({ policy, onSave, onDelete, onClose }: {
  policy: PolicyForm; onSave: (p: PolicyForm) => Promise<void>; onDelete?: () => Promise<void>; onClose: () => void;
}) {
  const isNew = !policy.id;
  const [form, setForm] = useState<PolicyForm>({ ...policy });
  const set = <K extends keyof PolicyForm>(k: K, v: PolicyForm[K]) => setForm(f => ({ ...f, [k]: v }));
  const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  async function save() {
    if (!form.name.trim()) { setError("Policy name is required."); return; }
    if (!form.keyField.trim()) { setError("Key field path is required."); return; }
    if (!form.cradleField.trim() || !form.cradleValue.trim()) { setError("Cradle field and value are required."); return; }
    if (!form.graveField.trim() || !form.graveValue.trim()) { setError("Grave field and value are required."); return; }
    setSaving(true);
    try { await onSave(form); onClose(); } catch (e: any) { setError(e.message ?? "Save failed."); } finally { setSaving(false); }
  }
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(26,25,22,0.55)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: 620, maxHeight: "92vh", overflowY: "auto", background: C.surface, borderRadius: 12, border: `1px solid ${C.border}` }}>
        <div style={{ padding: "18px 24px 14px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start", position: "sticky", top: 0, background: C.surface, zIndex: 1 }}>
          <div><div style={{ fontSize: 15, fontWeight: 800 }}>{isNew ? "New Aggregation Policy" : `Edit — ${policy.name}`}</div><div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>Defines correlation key, cradle condition, and grave condition</div></div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.textMuted }}>×</button>
        </div>
        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 22 }}>
          <div>
            <SectionLabel text="Identity" />
            <div style={{ display: "flex", gap: 12 }}><FInput label="Policy Name *" value={form.name} onChange={v => set("name", v)} placeholder="e.g. User Session" /><FInput label="Event Domain" value={form.domain} onChange={v => set("domain", v)} placeholder="e.g. user.* or *" /></div>
            <div style={{ marginTop: 10 }}><FInput label="Description" value={form.description} onChange={v => set("description", v)} placeholder="Human-readable purpose" /></div>
          </div>
          <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 18 }}>
            <SectionLabel text="Conditions — all three evaluated against every ingested segment body" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
              <div style={{ padding: "14px 16px", borderRadius: 8, border: `2px solid ${C.info}50`, background: C.infoLight }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: C.info, letterSpacing: "0.05em", marginBottom: 12 }}>⬡ AGGREGATION KEY</div>
                <FInput label="Field path *" value={form.keyField} onChange={v => set("keyField", v)} placeholder="sessionId" mono />
                <div style={{ marginTop: 8, fontSize: 10, color: C.textMuted }}>Value at this path becomes the correlation key</div>
                {form.keyField && <div style={{ marginTop: 8, background: C.surface, borderRadius: 4, padding: "4px 8px", fontSize: 10, fontFamily: "monospace", color: C.info }}>key = body.{form.keyField}</div>}
              </div>
              <div style={{ padding: "14px 16px", borderRadius: 8, border: `2px solid ${C.accent}50`, background: C.accentLight }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: C.accent, letterSpacing: "0.05em", marginBottom: 12 }}>▶ CRADLE / START</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}><FInput label="Field path *" value={form.cradleField} onChange={v => set("cradleField", v)} placeholder="eventType" mono /><FInput label="Must equal *" value={form.cradleValue} onChange={v => set("cradleValue", v)} placeholder="user.login" mono /></div>
                {form.cradleField && form.cradleValue && <div style={{ marginTop: 8, background: C.surface, borderRadius: 4, padding: "4px 8px", fontSize: 10, fontFamily: "monospace", color: C.accent }}>body.{form.cradleField} === "{form.cradleValue}"</div>}
              </div>
              <div style={{ padding: "14px 16px", borderRadius: 8, border: `2px solid ${C.danger}40`, background: C.dangerLight }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: C.danger, letterSpacing: "0.05em", marginBottom: 12 }}>■ GRAVE / END</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}><FInput label="Field path *" value={form.graveField} onChange={v => set("graveField", v)} placeholder="status" mono /><FInput label="Must equal *" value={form.graveValue} onChange={v => set("graveValue", v)} placeholder="settled" mono /></div>
                {form.graveField && form.graveValue && <div style={{ marginTop: 8, background: C.surface, borderRadius: 4, padding: "4px 8px", fontSize: 10, fontFamily: "monospace", color: C.danger }}>body.{form.graveField} === "{form.graveValue}"</div>}
              </div>
            </div>
            <div style={{ marginTop: 10, fontSize: 11, color: C.textMuted }}>Paths use dot-notation resolved against the full event body JSON. No lifecycle flags needed from the producer.</div>
          </div>
          <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 18 }}>
            <SectionLabel text="⏱ Auto-timeout" />
            <div style={{ marginBottom: 8, fontSize: 11, color: C.textMuted }}>Automatically close groups that stop receiving segments. Defaults to off — grave segment required to close.</div>
            <DurationInput value={form.timeoutMs} onChange={v => set("timeoutMs", v)} />
          </div>
          {error && <div style={{ padding: "8px 12px", borderRadius: 6, background: C.dangerLight, color: C.danger, fontSize: 12 }}>{error}</div>}
          <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 4 }}>
            {!isNew && onDelete ? <Btn label="Delete Policy" onClick={async () => { await onDelete(); onClose(); }} variant="danger" /> : <div />}
            <div style={{ display: "flex", gap: 8 }}><Btn label="Cancel" onClick={onClose} /><Btn label={saving ? "Saving…" : isNew ? "Create Policy" : "Save Changes"} onClick={save} variant="primary" /></div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Policies Panel ───────────────────────────────────────────────────────────
function Toggle({ active, onChange }: { active: boolean; onChange: () => void }) {
  return (
    <button onClick={onChange}
      style={{ position: "relative", width: 36, height: 20, borderRadius: 10, border: "none", background: active ? C.accent : C.borderStrong, cursor: "pointer", padding: 0, transition: "background 0.2s", flexShrink: 0 }}>
      <div style={{ position: "absolute", top: 2, left: active ? 18 : 2, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
    </button>
  );
}

function ValidatePolicyPanel({ pol }: { pol: Policy }) {
  const defaultBody = JSON.stringify({ eventType: `${pol.domain.replace(".*","")}.event`, [pol.keyField]: "example-key-001" }, null, 2);
  const [bodyText, setBodyText] = useState(defaultBody);
  const [result,   setResult]   = useState<{ checks: { icon: string; label: string; color: string; field: string; resolved: unknown; expected?: string; pass: boolean; note: string }[]; outcome: { bg: string; color: string; border: string; label: string; desc: string } } | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);

  function resolvePath(obj: Record<string, unknown>, path: string): unknown {
    return path.split(".").reduce<unknown>((cur, k) =>
      cur !== null && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined, obj);
  }

  function validate() {
    try {
      const body = JSON.parse(bodyText) as Record<string, unknown>;
      setParseErr(null);
      const keyResolved    = resolvePath(body, pol.keyField);
      const cradleResolved = resolvePath(body, pol.cradleField);
      const graveResolved  = resolvePath(body, pol.graveField);
      const keyOk    = keyResolved !== undefined && keyResolved !== null && String(keyResolved).length > 0;
      const isCradle = String(cradleResolved) === pol.cradleValue;
      const isGrave  = String(graveResolved)  === pol.graveValue;
      const checks = [
        { icon: "⬡", label: "KEY",   color: C.info,   field: `body.${pol.keyField}`,    resolved: keyResolved,    expected: undefined,        pass: keyOk,    note: keyOk ? `Aggregation key: "${keyResolved}"` : `body.${pol.keyField} not found — event would be rejected` },
        { icon: "▶", label: "START", color: C.accent, field: `body.${pol.cradleField}`, resolved: cradleResolved, expected: pol.cradleValue,  pass: isCradle, note: isCradle ? "Cradle matched — would OPEN a new group" : "Cradle not matched" },
        { icon: "■", label: "END",   color: C.danger, field: `body.${pol.graveField}`,  resolved: graveResolved,  expected: pol.graveValue,   pass: isGrave,  note: isGrave  ? "Grave matched — would CLOSE the group" : "Grave not matched" },
      ];
      const outcome = !keyOk
        ? { bg: C.dangerLight, color: C.danger, border: C.danger+"40", label: "✕  Key unresolvable",             desc: `body.${pol.keyField} is missing. Ingest would return 422 Unprocessable Entity.` }
        : isCradle && isGrave
        ? { bg: C.warnLight,   color: C.warn,   border: C.warn+"40",   label: "⚠  Cradle + Grave simultaneously", desc: "Both conditions matched. A group would open and immediately close with one segment." }
        : isCradle
        ? { bg: C.accentLight, color: C.accent, border: C.accentSoft,  label: "▶  Opens a new group",             desc: `POST /api/v1/events/ingest → 201 Created. New in_progress group with key "${keyResolved}".` }
        : isGrave
        ? { bg: C.dangerLight, color: C.danger, border: C.danger+"40", label: "■  Closes an open group",          desc: `POST /api/v1/events/ingest → 200 OK. Group for key "${keyResolved}" promoted to completed_events.` }
        : { bg: C.infoLight,   color: C.info,   border: C.info+"40",   label: "+  Intermediate segment",           desc: `POST /api/v1/events/ingest → 200 OK. Segment appended to existing group for key "${keyResolved}".` };
      setResult({ checks, outcome });
    } catch { setParseErr("Invalid JSON — check your event body"); setResult(null); }
  }

  return (
    <div style={{ padding: "14px 16px", borderTop: `1px solid ${C.border}`, background: C.bg }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 5 }}>Event body (JSON)</div>
        <textarea value={bodyText} onChange={e => { setBodyText(e.target.value); setResult(null); setParseErr(null); }} rows={5}
          style={{ width: "100%", fontFamily: "monospace", fontSize: 11, border: `1px solid ${parseErr ? C.danger : C.border}`, borderRadius: 6, padding: "8px 10px", background: C.surface, color: C.text, outline: "none", resize: "vertical" as const, lineHeight: 1.5, boxSizing: "border-box" as const }} />
        {parseErr && <div style={{ fontSize: 10, color: C.danger, marginTop: 3 }}>{parseErr}</div>}
      </div>
      <button onClick={validate} style={{ padding: "6px 16px", background: C.accent, color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 700, fontFamily: "inherit", marginBottom: result ? 14 : 0 }}>
        ▶ Run dry run
      </button>
      {result && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ padding: "10px 14px", borderRadius: 8, background: result.outcome.bg, border: `1px solid ${result.outcome.border}` }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: result.outcome.color, marginBottom: 3 }}>{result.outcome.label}</div>
            <div style={{ fontSize: 11, color: result.outcome.color, opacity: 0.85, fontFamily: "monospace" }}>{result.outcome.desc}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 6 }}>Condition evaluation</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {result.checks.map((ck, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 12px", borderRadius: 6, background: ck.pass ? C.accentLight : C.dangerLight, border: `1px solid ${ck.pass ? C.accentSoft : C.danger+"40"}` }}>
                  <span style={{ fontSize: 13, color: ck.pass ? C.accent : C.danger, lineHeight: "1.4", flexShrink: 0 }}>{ck.pass ? "✓" : "✕"}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" as const, marginBottom: 4 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: ck.color }}>{ck.icon}</span>
                      <ConditionPill label={ck.label} field={ck.field} value={ck.expected} color={ck.color} />
                    </div>
                    <div style={{ fontSize: 10, color: C.textMuted, display: "flex", gap: 5 }}>
                      <span>resolved:</span>
                      <code style={{ fontFamily: "monospace", color: ck.resolved !== undefined ? C.text : C.danger }}>{ck.resolved !== undefined ? `"${ck.resolved}"` : "undefined"}</code>
                    </div>
                    <div style={{ fontSize: 10, color: ck.pass ? C.accent : C.danger, marginTop: 3, fontWeight: 600 }}>{ck.note}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PoliciesPanel({ policies, onSave, onDelete, onToggle, onClose }: {
  policies: Policy[]; onSave: (p: PolicyForm) => Promise<void>; onDelete: (id: string) => Promise<void>; onToggle: (id: string, active: boolean) => Promise<void>; onClose: () => void;
}) {
  const [editing,      setEditing]      = useState<PolicyForm | null>(null);
  const [search,       setSearch]       = useState("");
  const [statusFilter, setStatusFilter] = useState<"all"|"active"|"inactive">("all");
  const [validateOpen, setValidateOpen] = useState<string | null>(null);
  const [confirm,      setConfirm]      = useState<{ pol: Policy; activating: boolean } | null>(null);

  const toForm = (p: Policy): PolicyForm => ({ id: p.id, name: p.name, domain: p.domain, keyField: p.keyField, cradleField: p.cradleField, cradleValue: p.cradleValue, graveField: p.graveField, graveValue: p.graveValue, description: p.description ?? "", timeoutMs: p.timeoutMs ?? null });

  const activeCount   = policies.filter(p => p.isActive).length;
  const inactiveCount = policies.filter(p => !p.isActive).length;

  const filtered = policies.filter(p => {
    const q = search.toLowerCase();
    const matchSearch = !q || p.name.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q) || p.domain.toLowerCase().includes(q);
    const matchStatus = statusFilter === "all" || (statusFilter === "active" ? p.isActive : !p.isActive);
    return matchSearch && matchStatus;
  });

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(26,25,22,0.45)", zIndex: 100, display: "flex", alignItems: "flex-start", justifyContent: "flex-end" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: 560, height: "100vh", background: C.surface, borderLeft: `1px solid ${C.border}`, overflowY: "auto", display: "flex", flexDirection: "column", animation: "slideIn 0.2s ease" }}>

        {/* Header */}
        <div style={{ padding: "18px 24px 14px", borderBottom: `1px solid ${C.border}`, position: "sticky", top: 0, background: C.surface, zIndex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 800 }}>Aggregation Policies</div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{activeCount} active · {inactiveCount} inactive</div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn label="+ New Policy" onClick={() => setEditing(blankPolicy())} variant="primary" small />
              <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.textMuted }}>×</button>
            </div>
          </div>

          {/* Search */}
          <div style={{ position: "relative", marginBottom: 8 }}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke={C.textMuted} strokeWidth="1.5"
              style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
              <circle cx="6.5" cy="6.5" r="4.5"/><path d="M10 10l3 3"/>
            </svg>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name, domain, or description…"
              style={{ width: "100%", padding: "7px 10px 7px 30px", border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, color: C.text, background: C.surfaceAlt, outline: "none", fontFamily: "inherit" }} />
            {search && <button onClick={() => setSearch("")} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: C.textMuted, fontSize: 15, lineHeight: 1, padding: 0 }}>×</button>}
          </div>

          {/* Status filter pills */}
          <div style={{ display: "flex", gap: 6 }}>
            {(["all","active","inactive"] as const).map(f => (
              <button key={f} onClick={() => setStatusFilter(f)}
                style={{ padding: "3px 10px", border: `1px solid ${statusFilter === f ? C.accent : C.border}`, borderRadius: 20, background: statusFilter === f ? C.accentLight : "none", cursor: "pointer", fontSize: 10, fontWeight: statusFilter === f ? 700 : 400, color: statusFilter === f ? C.accent : C.textMid, fontFamily: "inherit", textTransform: "capitalize" as const }}>
                {f === "all" ? `All (${policies.length})` : f === "active" ? `Active (${activeCount})` : `Inactive (${inactiveCount})`}
              </button>
            ))}
          </div>
        </div>

        {/* Policy cards */}
        <div style={{ padding: "16px 24px", flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
          {filtered.length === 0 && (
            <div style={{ padding: 32, textAlign: "center", color: C.textMuted, fontSize: 13 }}>
              {search ? `No policies matching "${search}"` : "No policies in this filter."}
            </div>
          )}
          {filtered.map(pol => (
            <div key={pol.id} style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", opacity: pol.isActive ? 1 : 0.8 }}>

              {/* Card header */}
              <div style={{ padding: "12px 16px", background: pol.isActive ? C.surfaceAlt : "#ECEAE6", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4, flexWrap: "wrap" as const }}>
                    <span style={{ fontSize: 13, fontWeight: 800, color: pol.isActive ? C.text : C.textMuted }}>{pol.name}</span>
                    <code style={{ fontSize: 10, color: C.textMuted, background: C.surface, padding: "1px 6px", borderRadius: 3, border: `1px solid ${C.border}` }}>{pol.domain}</code>
                    <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: pol.isActive ? C.accentLight : "#ECEAE6", color: pol.isActive ? C.accent : C.textMuted, border: `1px solid ${pol.isActive ? C.accentSoft : C.border}` }}>
                      {pol.isActive ? "● Active" : "○ Inactive"}
                    </span>
                    {pol.timeoutMs && (
                      <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: C.timeoutLight, color: C.timeout, border: `1px solid ${C.timeoutSoft}` }}>
                        ⏱ {fmtMs(pol.timeoutMs)} timeout
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: C.textMuted }}>{pol.description}</div>
                  <CopyableId id={pol.id} />
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0, marginLeft: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 10, color: C.textMuted }}>{pol.isActive ? "Active" : "Inactive"}</span>
                    <Toggle active={pol.isActive} onChange={() => setConfirm({ pol, activating: !pol.isActive })} />
                  </div>
                  <Btn label="Edit" onClick={() => setEditing(toForm(pol))} small />
                </div>
              </div>

              {/* Conditions */}
              <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 7, opacity: pol.isActive ? 1 : 0.5 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" as const }}><span style={{ fontSize: 10, fontWeight: 700, color: C.info, minWidth: 36 }}>⬡</span><ConditionPill label="KEY" field={`body.${pol.keyField}`} color={C.info} /><span style={{ fontSize: 10, color: C.textMuted }}>→ aggregation key</span></div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" as const }}><span style={{ fontSize: 10, fontWeight: 700, color: C.accent, minWidth: 36 }}>▶</span><ConditionPill label="IF" field={`body.${pol.cradleField}`} value={pol.cradleValue} color={C.accent} /><span style={{ fontSize: 10, color: C.textMuted }}>→ open group</span></div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" as const }}><span style={{ fontSize: 10, fontWeight: 700, color: C.danger, minWidth: 36 }}>■</span><ConditionPill label="IF" field={`body.${pol.graveField}`} value={pol.graveValue} color={C.danger} /><span style={{ fontSize: 10, color: C.textMuted }}>→ close group</span></div>

                {/* Validate toggle */}
                <div style={{ marginTop: 2, paddingTop: 8, borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "flex-end" }}>
                  <button onClick={() => setValidateOpen(validateOpen === pol.id ? null : pol.id)}
                    style={{ padding: "4px 12px", border: `1px solid ${validateOpen === pol.id ? C.purple : C.border}`, borderRadius: 20, background: validateOpen === pol.id ? C.purpleLight : "none", cursor: "pointer", fontSize: 10, fontWeight: 600, color: validateOpen === pol.id ? C.purple : C.textMid, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5, transition: "all 0.15s" }}>
                    {validateOpen === pol.id ? "▲ Hide validator" : "▶ Validate event body"}
                  </button>
                </div>
              </div>

              {validateOpen === pol.id && <ValidatePolicyPanel pol={pol} />}
            </div>
          ))}
          {policies.length === 0 && filtered.length === 0 && <div style={{ padding: 32, textAlign: "center", color: C.textMuted, fontSize: 13 }}>No policies yet. Create one to start ingesting events.</div>}
        </div>

        <div style={{ padding: "12px 24px", borderTop: `1px solid ${C.border}`, background: C.surfaceAlt }}>
          <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 4, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" as const }}>Policy API</div>
          {["GET /api/v1/policies", "POST /api/v1/policies", "PUT /api/v1/policies/:id", "DELETE /api/v1/policies/:id"].map(e => <div key={e} style={{ fontSize: 11, fontFamily: "monospace", color: C.accent }}>{e}</div>)}
        </div>
      </div>

      {/* Confirm dialog */}
      {confirm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(26,25,22,0.55)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setConfirm(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background: C.surface, borderRadius: 10, border: `1px solid ${C.border}`, padding: "24px 28px", width: 400, boxShadow: "0 8px 40px rgba(0,0,0,0.18)" }}>
            <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 8 }}>{confirm.activating ? "Activate policy?" : "Deactivate policy?"}</div>
            <div style={{ fontSize: 12, color: C.textMid, lineHeight: 1.6, marginBottom: 20 }}>
              {confirm.activating
                ? <><strong>{confirm.pol.name}</strong> will immediately start accepting ingest events. New groups will open when the cradle condition is matched.</>
                : <><strong>{confirm.pol.name}</strong> will stop processing new events. Existing open groups are preserved in <code style={{ fontFamily: "monospace", fontSize: 11 }}>in_progress_events</code> until a grave segment is received.</>
              }
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn label="Cancel" onClick={() => setConfirm(null)} />
              <Btn label={confirm.activating ? "Activate" : "Deactivate"} onClick={async () => { await onToggle(confirm.pol.id, !confirm.pol.isActive); setConfirm(null); }} variant={confirm.activating ? "primary" : "danger"} />
            </div>
          </div>
        </div>
      )}

      {editing && <PolicyEditor policy={editing} onSave={onSave} onDelete={editing.id ? () => onDelete(editing.id!) : undefined} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ─── Event Detail Panel ───────────────────────────────────────────────────────
function EventDetail({ event, policy, onClose, initialSegmentId }: { event: EventGroupDetail; policy: Policy | undefined; onClose: () => void; initialSegmentId?: string }) {
  const initialIdx = initialSegmentId ? event.segments.findIndex(s => s.eventId === initialSegmentId) : null;
  const [openSeg,  setOpenSeg]  = useState<number | null>(initialIdx !== null && initialIdx >= 0 ? initialIdx : null);
  const [detailTab, setDetailTab] = useState<"list"|"timeline">("list");
  const [timelineSeg, setTimelineSeg] = useState<number | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const expandedRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (openSeg !== null && expandedRef.current) {
      setTimeout(() => expandedRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 120);
    }
  }, []);

  function handleExport(format: "JSON" | "CSV") {
    setShowExportMenu(false);
    if (format === "JSON") {
      const payload = {
        exportedAt: new Date().toISOString(),
        id: event.id,
        policyName: event.policyName,
        aggregationKey: event.aggregationKey,
        keyField: event.keyField,
        status: event.status,
        startTime: event.startTime,
        endTime: event.endTime,
        durationMs: event.endTime ? new Date(event.endTime).getTime() - new Date(event.startTime).getTime() : null,
        segmentCount: event.segments.length,
        segments: event.segments.map(s => ({ eventId: s.eventId, sequence: s.sequence, timestamp: s.timestamp, body: s.body })),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `eventagg-group-${event.aggregationKey}-${Date.now()}.json`; a.click();
    } else {
      const rows = [["sequence","eventId","timestamp","body"]];
      event.segments.forEach(s => rows.push([String(s.sequence), s.eventId, s.timestamp, JSON.stringify(s.body)]));
      const csv = rows.map(r => r.map(v => v.includes(",") || v.includes('"') ? `"${v.replace(/"/g,'""')}"` : v).join(",")).join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `eventagg-group-${event.aggregationKey}-${Date.now()}.csv`; a.click();
    }
  }

  // Timeline calculations
  const totalMs = event.endTime
    ? new Date(event.endTime).getTime() - new Date(event.startTime).getTime()
    : Date.now() - new Date(event.startTime).getTime();
  const startMs = new Date(event.startTime).getTime();
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(26,25,22,0.45)", zIndex: 100, display: "flex", alignItems: "flex-start", justifyContent: "flex-end" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: 520, height: "100vh", background: C.surface, borderLeft: `1px solid ${C.border}`, overflowY: "auto", display: "flex", flexDirection: "column", animation: "slideIn 0.2s ease" }}>
        <div style={{ padding: "18px 24px 14px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start", position: "sticky", top: 0, background: C.surface, zIndex: 1 }}>
          <div>
            <div style={{ fontSize: 11, color: C.textMuted, fontFamily: "monospace", marginBottom: 4 }}>EVENT GROUP</div>
            <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "monospace" }}>{event.id}</div>
            <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" as const }}><StatusBadge status={event.status} /><Badge label={`⚙ ${event.policyName}`} bg={C.purpleLight} color={C.purple} /></div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0, marginLeft: 8 }}>
            <div style={{ position: "relative" }}>
              <button onClick={() => setShowExportMenu(v => !v)}
                style={{ padding: "5px 10px", border: `1px solid ${C.border}`, borderRadius: 6, background: showExportMenu ? C.surfaceAlt : C.surface, cursor: "pointer", fontFamily: "inherit", fontSize: 11, fontWeight: 600, color: C.textMid, display: "flex", alignItems: "center", gap: 5 }}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 2v9M5 8l3 3 3-3M2 13h12"/></svg>
                Export
              </button>
              {showExportMenu && (
                <div style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: "0 4px 20px rgba(0,0,0,0.12)", zIndex: 50, minWidth: 180, padding: 6 }}>
                  <div style={{ padding: "4px 10px 6px", fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.07em" }}>Export group</div>
                  {([{ fmt: "JSON" as const, icon: "{ }", desc: "Full group + segments" }, { fmt: "CSV" as const, icon: "⊞", desc: "Segments as rows" }]).map(opt => (
                    <button key={opt.fmt} onClick={() => handleExport(opt.fmt)}
                      style={{ width: "100%", padding: "7px 10px", border: "none", borderRadius: 6, background: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left" as const, display: "flex", gap: 10, alignItems: "flex-start" }}
                      onMouseEnter={e => (e.currentTarget.style.background = C.surfaceAlt)}
                      onMouseLeave={e => (e.currentTarget.style.background = "none")}>
                      <span style={{ fontSize: 13, lineHeight: "1.3", flexShrink: 0 }}>{opt.icon}</span>
                      <div><div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{opt.fmt}</div><div style={{ fontSize: 10, color: C.textMuted, marginTop: 1 }}>{opt.desc}</div></div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.textMuted }}>×</button>
          </div>
        </div>
        <div style={{ padding: "14px 24px", borderBottom: `1px solid ${C.border}`, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {([["Aggregation Key", event.aggregationKey, true], ["Key Source", `body.${event.keyField}`, true], ["Start", fmt(event.startTime), false], ["End", fmt(event.endTime), false], ["Duration", fmtDur(event.startTime, event.endTime), false], ["Store", event.status !== "in_progress" ? "completed_events" : "in_progress_events", true], ...(event.status === "timed_out" ? [["Close Reason", "policy_timeout", true]] : [])] as [string, string, boolean][]).map(([k, v, mono]) => (
            <div key={k}><div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: k === "Close Reason" ? C.timeout : C.textMuted, textTransform: "uppercase" as const, marginBottom: 2 }}>{k}</div><div style={{ fontSize: 12, color: k === "Close Reason" ? C.timeout : C.text, fontFamily: mono ? "monospace" : "inherit", wordBreak: "break-all" }}>{v}</div></div>
          ))}
        </div>
        {/* Timeout banner */}
        {event.status === "timed_out" && policy?.timeoutMs && (
          <div style={{ margin: "12px 24px 0", background: C.timeoutLight, border: `1px solid ${C.timeoutSoft}`, borderRadius: 8, padding: "10px 14px" }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: C.timeout, marginBottom: 3 }}>⏱ Group timed out — no grave received</div>
            <div style={{ fontSize: 11, color: C.timeout, opacity: 0.9, lineHeight: 1.5 }}>
              Auto-closed after <strong>{fmtMs(policy.timeoutMs)}</strong> with no grave segment.
              Clock started at cradle and reset on each subsequent segment.
            </div>
          </div>
        )}
        {policy && (
          <div style={{ padding: "12px 24px", borderBottom: `1px solid ${C.border}`, background: C.surfaceAlt }}>
            <SectionLabel text="Applied Policy Conditions" />
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}><span style={{ fontSize: 10, color: C.info, fontWeight: 800, minWidth: 40 }}>⬡ KEY</span><ConditionPill label="KEY" field={`body.${policy.keyField}`} color={C.info} /></div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}><span style={{ fontSize: 10, color: C.accent, fontWeight: 800, minWidth: 40 }}>▶ START</span><ConditionPill label="IF" field={`body.${policy.cradleField}`} value={policy.cradleValue} color={C.accent} /></div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}><span style={{ fontSize: 10, color: C.danger, fontWeight: 800, minWidth: 40 }}>■ END</span><ConditionPill label="IF" field={`body.${policy.graveField}`} value={policy.graveValue} color={C.danger} /></div>
            </div>
          </div>
        )}
        <div style={{ padding: "14px 24px", flex: 1 }}>
          {/* Segments heading + List/Timeline toggle */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <SectionLabel text={`Segments (${event.segments.length})`} />
            <div style={{ display: "flex", background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 6, padding: 2, gap: 2 }}>
              {(["list","timeline"] as const).map(t => (
                <button key={t} onClick={() => setDetailTab(t)}
                  style={{ padding: "3px 10px", border: "none", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 11, fontWeight: detailTab === t ? 700 : 400, color: detailTab === t ? C.accent : C.textMid, background: detailTab === t ? C.surface : "none", boxShadow: detailTab === t ? "0 1px 3px rgba(0,0,0,0.08)" : "none", transition: "all 0.15s" }}>
                  {t === "timeline" ? "⟡ Timeline" : "≡ List"}
                </button>
              ))}
            </div>
          </div>

          {/* ── Timeline tab ── */}
          {detailTab === "timeline" && (
            <div>
              {/* Track */}
              <div style={{ position: "relative", height: 8, background: C.surfaceAlt, borderRadius: 4, margin: "28px 8px 52px" }}>
                <div style={{ position: "absolute", inset: 0, background: `linear-gradient(90deg, ${C.accentSoft}, ${C.accent})`, borderRadius: 4, opacity: 0.25 }} />
                {event.segments.map((seg, i) => {
                  const pct = Math.min(((new Date(seg.timestamp).getTime() - startMs) / totalMs) * 100, 96);
                  const isCradle = policy && String(resolvePath(seg.body, policy.cradleField)) === policy.cradleValue;
                  const isGrave  = policy && String(resolvePath(seg.body, policy.graveField))  === policy.graveValue;
                  const color = isCradle ? C.accent : isGrave ? C.danger : C.info;
                  return (
                    <div key={seg.eventId} onClick={() => setTimelineSeg(timelineSeg === i ? null : i)}
                      style={{ position: "absolute", left: `${pct}%`, top: "50%", transform: "translate(-50%,-50%)", cursor: "pointer", zIndex: 2 }}>
                      <div style={{ position: "absolute", left: "50%", top: 8, width: 1, height: 28, background: color, opacity: 0.4 }} />
                      <div style={{ width: 16, height: 16, borderRadius: "50%", background: timelineSeg === i ? color : C.surface, border: `2px solid ${color}`, transition: "background 0.15s", boxShadow: timelineSeg === i ? `0 0 0 3px ${color}30` : "none" }} />
                      <div style={{ position: "absolute", top: 38, left: "50%", transform: "translateX(-50%)", whiteSpace: "nowrap" as const, fontSize: 10, fontFamily: "monospace", color, fontWeight: 700, textAlign: "center" as const }}>
                        {seg.sequence}. {String(seg.body.eventType ?? Object.keys(seg.body)[0] ?? "—").split(".").pop()}
                        {isCradle && <div style={{ fontSize: 9, color: C.accent }}>▶ cradle</div>}
                        {isGrave  && <div style={{ fontSize: 9, color: C.danger }}>■ grave</div>}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Gap labels */}
              <div style={{ position: "relative", height: 20, margin: "8px 8px 0" }}>
                {event.segments.slice(0,-1).map((seg, i) => {
                  const next = event.segments[i+1];
                  const sp = Math.min(((new Date(seg.timestamp).getTime() - startMs) / totalMs) * 100, 96);
                  const ep = Math.min(((new Date(next.timestamp).getTime() - startMs) / totalMs) * 100, 96);
                  const gapMs = new Date(next.timestamp).getTime() - new Date(seg.timestamp).getTime();
                  return (
                    <div key={i} style={{ position: "absolute", left: `${(sp+ep)/2}%`, transform: "translateX(-50%)", whiteSpace: "nowrap" as const }}>
                      <span style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 10, padding: "2px 6px", fontSize: 9, color: C.textMuted }}>{fmtMs(gapMs)}</span>
                    </div>
                  );
                })}
              </div>

              {/* Time axis */}
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 20, paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
                <span style={{ fontSize: 9, color: C.textMuted, fontFamily: "monospace" }}>{fmt(event.startTime)}</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: C.purple, fontFamily: "monospace" }}>{fmtMs(totalMs)} total</span>
                <span style={{ fontSize: 9, color: C.textMuted, fontFamily: "monospace" }}>{event.endTime ? fmt(event.endTime) : "ongoing"}</span>
              </div>

              {/* Selected segment */}
              {timelineSeg !== null && (
                <div style={{ marginTop: 12, background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 6, padding: "10px 12px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontSize: 11, fontWeight: 700 }}>Segment {event.segments[timelineSeg].sequence}</span>
                    <span style={{ fontSize: 10, color: C.textMuted }}>{fmt(event.segments[timelineSeg].timestamp)}</span>
                  </div>
                  <pre style={{ margin: 0, fontSize: 11, fontFamily: "monospace", color: C.text, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, padding: "8px 10px", overflow: "auto", maxHeight: 160 }}>
                    {JSON.stringify(event.segments[timelineSeg].body, null, 2)}
                  </pre>
                </div>
              )}
              {timelineSeg === null && <div style={{ marginTop: 10, fontSize: 10, color: C.textMuted, textAlign: "center" as const }}>Click any segment dot to inspect its body</div>}
            </div>
          )}

          {/* ── List tab ── */}
          {detailTab === "list" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {event.segments.map((seg, i) => {
              const isCradle  = policy && String(resolvePath(seg.body, policy.cradleField)) === policy.cradleValue;
              const isGrave   = policy && String(resolvePath(seg.body, policy.graveField))  === policy.graveValue;
              const isLastSeg = event.status === "timed_out" && i === event.segments.length - 1;
              const borderColor = isCradle ? C.accent + "55" : isGrave ? C.danger + "55" : isLastSeg ? C.timeout + "55" : C.border;
              const dotColor    = isCradle ? C.accent : isGrave ? C.danger : isLastSeg ? C.timeout : C.borderStrong;
              return (
                <div key={seg.eventId} ref={i === openSeg ? expandedRef : undefined} style={{ border: `1px solid ${borderColor}`, borderRadius: 8, overflow: "hidden" }}>
                  <div onClick={() => setOpenSeg(openSeg === i ? null : i)} style={{ padding: "9px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", background: openSeg === i ? C.surfaceAlt : isLastSeg ? C.timeoutLight : C.surface, userSelect: "none" as const }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span style={{ width: 20, height: 20, borderRadius: "50%", background: dotColor, color: "#fff", fontSize: 9, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{i + 1}</span>
                      <div>
                        <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" as const }}>
                          <span style={{ fontSize: 12, fontFamily: "monospace", color: C.text }}>{String(seg.body.eventType ?? seg.body.status ?? Object.keys(seg.body)[0] ?? "—")}</span>
                          {isCradle   && <span style={{ fontSize: 9, fontWeight: 700, color: C.accent,   background: C.accentLight,   padding: "1px 5px", borderRadius: 3 }}>CRADLE</span>}
                          {isGrave    && <span style={{ fontSize: 9, fontWeight: 700, color: C.danger,   background: C.dangerLight,   padding: "1px 5px", borderRadius: 3 }}>GRAVE</span>}
                          {isLastSeg  && <span style={{ fontSize: 9, fontWeight: 700, color: C.timeout,  background: C.timeoutLight,  padding: "1px 5px", borderRadius: 3 }}>LAST BEFORE TIMEOUT</span>}
                        </div>
                        <div style={{ fontSize: 10, color: C.textMuted }}>{fmt(seg.timestamp)}</div>
                      </div>
                    </div>
                    <span style={{ color: C.textMuted, fontSize: 11 }}>{openSeg === i ? "▲" : "▼"}</span>
                  </div>
                  {openSeg === i && (
                    <div style={{ padding: "10px 14px", borderTop: `1px solid ${C.border}`, background: C.surfaceAlt }}>
                      <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 4, fontWeight: 700 }}>SEGMENT ID</div>
                      <div style={{ fontSize: 11, fontFamily: "monospace", color: C.textMid, marginBottom: 8 }}>{seg.eventId}</div>
                      <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 4, fontWeight: 700 }}>BODY</div>
                      <pre style={{ margin: 0, fontSize: 11, fontFamily: "monospace", color: C.text, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", overflowX: "auto", lineHeight: 1.5, maxHeight: 200, overflowY: "auto" }}>{JSON.stringify(seg.body, null, 2)}</pre>
                    </div>
                  )}
                </div>
              );
            })}
            {/* Timeout marker at end of segment list */}
            {event.status === "timed_out" && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", background: C.timeoutLight, border: `1px solid ${C.timeoutSoft}`, borderRadius: 8 }}>
                <span style={{ fontSize: 16 }}>⏱</span>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.timeout }}>Auto-closed by timeout</div>
                  <div style={{ fontSize: 10, color: C.timeout, opacity: 0.8 }}>
                    {event.endTime ? fmt(event.endTime) : ""}{policy?.timeoutMs ? ` · ${fmtMs(policy.timeoutMs)} policy timeout reached` : ""}
                  </div>
                </div>
              </div>
            )}
          </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Ingest Modal ─────────────────────────────────────────────────────────────
function IngestModal({ policies, onIngest, onClose }: {
  policies: Policy[]; onIngest: (input: { policyId: string; body: Record<string, unknown> }) => Promise<IngestResult>; onClose: () => void;
}) {
  const [policyId, setPolicyId] = useState(policies[0]?.id ?? "");
  const [body, setBody] = useState("");
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pol = policies.find(p => p.id === policyId);

  // Generate a template body for the selected policy
  function makeTemplate(type: "cradle" | "middle" | "grave"): string {
    if (!pol) return "{}";
    const base: Record<string, unknown> = {};
    // Always include the key field
    const keyPath = pol.keyField.replace(/^body\./, "");
    base[keyPath] = `${keyPath.toUpperCase().slice(0,3)}-001`;
    if (type === "cradle") {
      const field = pol.cradleField.replace(/^body\./, "");
      base[field] = pol.cradleValue;
    } else if (type === "grave") {
      const field = pol.graveField.replace(/^body\./, "");
      base[field] = pol.graveValue;
    } else {
      // Middle — use a neutral eventType if the field is eventType
      const field = pol.cradleField.replace(/^body\./, "");
      base[field] = "event.update";
    }
    return JSON.stringify(base, null, 2);
  }

  // Set template when policy changes
  React.useEffect(() => {
    setBody(makeTemplate("cradle"));
    setResult(null);
  }, [policyId]);

  function livePreview() {
    if (!pol) return null;
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const key = resolvePath(parsed, pol.keyField);
      const isCradle = String(resolvePath(parsed, pol.cradleField)) === pol.cradleValue;
      const isGrave  = String(resolvePath(parsed, pol.graveField))  === pol.graveValue;
      return { key, isCradle, isGrave, valid: true };
    } catch { return { valid: false }; }
  }
  async function handleIngest() {
    if (!pol || submitting) return;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(body); } catch { setResult({ ok: false, msg: "Invalid JSON body." }); return; }
    setSubmitting(true);
    try {
      const res = await onIngest({ policyId, body: parsed });
      const msgs = [`Segment ingested. Key: "${res.aggregationKey}".`];
      if (res.action === "group_opened")    msgs.push("▶ Cradle matched — new group opened.");
      if (res.action === "group_promoted")  msgs.push("■ Grave matched — group promoted to completed.");
      if (res.action === "segment_appended") msgs.push("Appended to existing in-progress group.");
      setResult({ ok: true, msg: msgs.join(" ") });
    } catch (e: any) { setResult({ ok: false, msg: e.message ?? "Ingest failed." }); }
    finally { setSubmitting(false); }
  }
  const prev = livePreview();
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(26,25,22,0.5)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: 600, background: C.surface, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden", maxHeight: "90vh", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "16px 22px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <div><div style={{ fontSize: 15, fontWeight: 800 }}>Ingest Event Segment</div><div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>Policy resolves key, cradle, and grave from the body</div></div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.textMuted }}>×</button>
        </div>
        <div style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
          <FSelect label="Aggregation Policy *" value={policyId} onChange={v => { setPolicyId(v); setResult(null); }} options={policies.map(p => ({ value: p.id, label: `${p.name} — ${p.domain}${p.isActive ? "" : " (inactive)"}` }))} />
          {pol && !pol.isActive && (
            <div style={{ padding: "8px 12px", borderRadius: 6, background: C.warnLight, border: `1px solid ${C.warn}40`, fontSize: 12, color: C.warn, fontWeight: 600 }}>
              ⚠ This policy is inactive — ingest will be rejected by the API.
            </div>
          )}
          {pol && (
            <div style={{ padding: "10px 14px", borderRadius: 8, background: C.surfaceAlt, border: `1px solid ${C.border}` }}>
              <SectionLabel text="Policy Rules" />
              <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 6 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}><span style={{ fontSize: 10, color: C.textMuted, minWidth: 46 }}>⬡ Key</span><ConditionPill label="KEY" field={`body.${pol.keyField}`} color={C.info} /></div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}><span style={{ fontSize: 10, color: C.textMuted, minWidth: 46 }}>▶ Start</span><ConditionPill label="IF" field={`body.${pol.cradleField}`} value={pol.cradleValue} color={C.accent} /></div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}><span style={{ fontSize: 10, color: C.textMuted, minWidth: 46 }}>■ End</span><ConditionPill label="IF" field={`body.${pol.graveField}`} value={pol.graveValue} color={C.danger} /></div>
                {pol.timeoutMs && <div style={{ display: "flex", gap: 8, alignItems: "center" }}><span style={{ fontSize: 10, color: C.textMuted, minWidth: 46 }}>⏱ Timeout</span><span style={{ fontSize: 11, fontFamily: "monospace", color: C.timeout }}>{fmtMs(pol.timeoutMs)}</span></div>}
              </div>
            </div>
          )}
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: C.textMuted, textTransform: "uppercase" as const }}>Event Body JSON *</span>
              {pol && (
                <div style={{ display: "flex", gap: 4 }}>
                  {[
                    { label: "▶ Cradle", type: "cradle" as const, color: C.accent },
                    { label: "→ Middle", type: "middle" as const, color: C.info },
                    { label: "■ Grave",  type: "grave"  as const, color: C.danger },
                  ].map(t => (
                    <button key={t.type} onClick={() => { setBody(makeTemplate(t.type)); setResult(null); }}
                      style={{ padding: "2px 8px", fontSize: 10, fontWeight: 600, border: `1px solid ${t.color}50`, borderRadius: 4, background: t.color + "14", color: t.color, cursor: "pointer", fontFamily: "inherit" }}>
                      {t.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <textarea value={body} onChange={e => { setBody(e.target.value); setResult(null); }} rows={7}
              style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", fontSize: 12, fontFamily: "monospace", color: C.text, background: C.surfaceAlt, outline: "none", resize: "vertical" }} />
          </label>
          {prev?.valid && pol && (
            <div style={{ padding: "10px 14px", borderRadius: 8, background: C.surface, border: `1px solid ${C.border}`, display: "flex", flexDirection: "column", gap: 4, fontSize: 11 }}>
              <div style={{ fontWeight: 700, color: C.textMid, marginBottom: 2 }}>Live Resolution</div>
              <div><span style={{ color: C.textMuted }}>⬡ Key: </span>{prev.key !== undefined && prev.key !== null ? <code style={{ fontFamily: "monospace", color: C.info, fontWeight: 700 }}>{String(prev.key)}</code> : <span style={{ color: C.danger, fontStyle: "italic" }}>unresolved — body.{pol.keyField} not found</span>}</div>
              <div><span style={{ color: C.textMuted }}>▶ Cradle: </span><span style={{ fontWeight: 700, color: prev.isCradle ? C.accent : C.textMuted }}>{prev.isCradle ? "YES — will open group" : "No"}</span></div>
              <div><span style={{ color: C.textMuted }}>■ Grave: </span><span style={{ fontWeight: 700, color: prev.isGrave ? C.danger : C.textMuted }}>{prev.isGrave ? "YES — will promote to completed" : "No"}</span></div>
            </div>
          )}
          {result && <div style={{ padding: "10px 14px", borderRadius: 6, background: result.ok ? C.accentLight : C.dangerLight, color: result.ok ? C.accent : C.danger, fontSize: 12, border: `1px solid ${result.ok ? C.accentSoft : "#FCA5A5"}` }}>{result.msg}</div>}
          <button onClick={handleIngest} disabled={submitting} style={{ padding: "10px 20px", background: submitting ? C.borderStrong : C.accent, color: "#fff", border: "none", borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: submitting ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
            {submitting ? "Sending…" : "POST /api/v1/events/ingest"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Body search helpers ──────────────────────────────────────────────────────
function classifyBodySearch(s: string): "pair" | "freetext" | "empty" {
  if (!s.trim()) return "empty";
  return /^[\w.[\]]+=[^\s=]+$/.test(s.trim()) ? "pair" : "freetext";
}

// ─── Compact Select ───────────────────────────────────────────────────────────
function CompactSelect({ value, onChange, options }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
}) {
  const isDefault = value === options[0]?.value;
  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{
          appearance: "none" as const,
          border: `1px solid ${isDefault ? C.border : C.accent + "80"}`,
          borderRadius: 6,
          padding: "6px 28px 6px 10px",
          fontSize: 12,
          fontFamily: "inherit",
          fontWeight: isDefault ? 400 : 600,
          color: isDefault ? C.textMid : C.accent,
          background: isDefault ? C.surfaceAlt : C.accentLight,
          cursor: "pointer",
          outline: "none",
          whiteSpace: "nowrap" as const,
          transition: "all 0.15s",
        }}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none"
        stroke={isDefault ? C.textMuted : C.accent} strokeWidth="2"
        style={{ position: "absolute", right: 9, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
        <path d="M4 6l4 4 4-4"/>
      </svg>
    </div>
  );
}

// ─── Policy Multi-Select ──────────────────────────────────────────────────────
// selected = array of INCLUDED policy IDs. Empty array = all policies selected.
function PolicyMultiSelect({ policies, selected, onChange }: {
  policies: Policy[]; selected: string[]; onChange: (v: string[]) => void;
}) {
  const [open,   setOpen]   = useState(false);
  const [search, setSearch] = useState("");
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function handler(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered   = policies.filter(p => p.name.toLowerCase().includes(search.toLowerCase()));
  const allSelected = selected.length === 0; // empty = all

  function toggle(id: string) {
    if (allSelected) {
      // Start from "all selected" — selecting one means excluding all others
      onChange(policies.map(p => p.id).filter(pid => pid !== id));
    } else if (selected.includes(id)) {
      // Deselect this one
      const next = selected.filter(s => s !== id);
      onChange(next.length === policies.length ? [] : next); // if all deselected → reset to all
    } else {
      // Add this one back
      const next = [...selected, id];
      onChange(next.length === policies.length ? [] : next); // if all included → reset to all
    }
  }

  // Whether a given policy is currently included
  function isIncluded(id: string) {
    return allSelected || selected.includes(id);
  }

  function buttonLabel() {
    if (allSelected) return "All policies";
    if (selected.length === 1) return policies.find(p => p.id === selected[0])?.name.replace(/^EXAMPLE - /, "") ?? "1 policy";
    return `${selected.length} policies`;
  }

  const isFiltered = !allSelected;
  const includedCount = allSelected ? policies.length : selected.length;

  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ display: "flex", alignItems: "center", gap: 6, border: `1px solid ${isFiltered ? C.accent + "80" : C.border}`, borderRadius: 6, padding: "6px 10px", fontSize: 12, fontFamily: "inherit", fontWeight: isFiltered ? 600 : 400, color: isFiltered ? C.accent : C.textMid, background: isFiltered ? C.accentLight : C.surfaceAlt, cursor: "pointer", outline: "none", whiteSpace: "nowrap" as const, transition: "all 0.15s" }}>
        {buttonLabel()}
        {isFiltered && <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.accent, display: "inline-block", flexShrink: 0 }} />}
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke={isFiltered ? C.accent : C.textMuted} strokeWidth="2" style={{ flexShrink: 0 }}>
          <path d={open ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"}/>
        </svg>
      </button>

      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 100, width: 280, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: "0 4px 20px rgba(0,0,0,0.12)", overflow: "hidden" }}>

          {/* Search */}
          <div style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}`, position: "relative" }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke={C.textMuted} strokeWidth="1.5"
              style={{ position: "absolute", left: 18, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
              <circle cx="6.5" cy="6.5" r="4.5"/><path d="M10 10l3 3"/>
            </svg>
            <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Search policies…"
              style={{ width: "100%", padding: "5px 24px 5px 26px", border: `1px solid ${C.border}`, borderRadius: 5, fontSize: 11, fontFamily: "inherit", color: C.text, background: C.surfaceAlt, outline: "none" }} />
            {search && <button onClick={() => setSearch("")} style={{ position: "absolute", right: 16, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: C.textMuted, fontSize: 14, padding: 0, lineHeight: 1 }}>×</button>}
          </div>

          {/* All / Clear row */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 12px", borderBottom: `1px solid ${C.border}`, background: C.surfaceAlt }}>
            <button onClick={() => onChange([])}
              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: allSelected ? 700 : 400, color: allSelected ? C.accent : C.textMid, border: "none", background: "none", cursor: "pointer", fontFamily: "inherit", padding: "2px 0" }}>
              <span style={{ width: 13, height: 13, border: `2px solid ${allSelected ? C.accent : C.border}`, borderRadius: 3, background: allSelected ? C.accent : "none", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "all 0.1s" }}>
                {allSelected && <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="#fff" strokeWidth="2"><path d="M1.5 5l2.5 2.5 4.5-4"/></svg>}
              </span>
              All policies
            </button>
            {isFiltered && <button onClick={() => { onChange([]); setOpen(false); }} style={{ fontSize: 11, color: C.textMuted, border: "none", background: "none", cursor: "pointer", fontFamily: "inherit" }}>Clear</button>}
          </div>

          {/* Policy list */}
          <div style={{ maxHeight: 220, overflowY: "auto" }}>
            {filtered.length === 0 && <div style={{ padding: "16px 12px", textAlign: "center", fontSize: 12, color: C.textMuted }}>No policies match "{search}"</div>}
            {filtered.map(p => {
              const checked = isIncluded(p.id);
              return (
                <button key={p.id} onClick={() => toggle(p.id)}
                  style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", border: "none", background: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left" as const }}
                  onMouseEnter={e => (e.currentTarget.style.background = C.surfaceAlt)}
                  onMouseLeave={e => (e.currentTarget.style.background = "none")}>
                  <span style={{ width: 14, height: 14, border: `2px solid ${checked ? C.accent : C.border}`, borderRadius: 3, background: checked ? C.accent : "none", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "all 0.1s" }}>
                    {checked && <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="#fff" strokeWidth="2"><path d="M1.5 5l2.5 2.5 4.5-4"/></svg>}
                  </span>
                  <span style={{ fontSize: 12, color: checked ? C.text : C.textMuted }}>{p.name.replace(/^EXAMPLE - /, "")}</span>
                </button>
              );
            })}
          </div>

          {/* Footer */}
          {isFiltered && (
            <div style={{ padding: "6px 12px", borderTop: `1px solid ${C.border}`, background: C.surfaceAlt, fontSize: 10, color: C.textMuted, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>{includedCount} of {policies.length} selected</span>
              <button onClick={() => setOpen(false)} style={{ padding: "3px 10px", background: C.accent, border: "none", borderRadius: 4, color: "#fff", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Apply</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
// Rests at a comfortable width sharing available space; expands on focus
function ExpandingInput({ label, value, onChange, placeholder, mono = false, helpContent }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; mono?: boolean; helpContent?: React.ReactNode;
}) {
  const [focused,  setFocused]  = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const helpRef  = useRef<HTMLDivElement>(null);
  const hasVal   = value.trim().length > 0;
  const mode     = classifyBodySearch(value);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (helpRef.current && !helpRef.current.contains(e.target as Node)) setShowHelp(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const activeColor = mono
    ? (mode === "pair" ? C.accent : mode === "freetext" ? C.info : C.accent)
    : C.accent;

  const borderCol = focused ? activeColor : hasVal ? activeColor + "80" : C.border;
  const bgCol     = hasVal ? (mono ? (mode === "pair" ? C.accentLight : C.infoLight) : C.accentLight) : focused ? C.surface : C.surfaceAlt;

  return (
    <div
      onClick={() => inputRef.current?.focus()}
      style={{
        flex: focused || hasVal ? "2 1 220px" : "1 1 160px",
        transition: "flex 0.2s ease",
        position: "relative",
        cursor: "text",
      }}
    >
      <div style={{
        border: `1px solid ${borderCol}`,
        borderRadius: 6,
        padding: "6px 32px 6px 10px",
        background: bgCol,
        display: "flex",
        alignItems: "center",
        gap: 6,
        transition: "all 0.2s ease",
      }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: hasVal ? activeColor : C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.07em", flexShrink: 0, userSelect: "none" as const }}>
          {label}
        </span>
        <div style={{ width: 1, height: 12, background: C.border, flexShrink: 0 }} />
        <input
          ref={inputRef}
          value={value}
          onChange={e => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          style={{ border: "none", outline: "none", background: "transparent", fontSize: 12, color: C.text, fontFamily: mono ? "'Courier New', monospace" : "inherit", width: "100%", minWidth: 0, padding: 0 }}
        />
      </div>
      {/* Clear */}
      {hasVal && (
        <button onMouseDown={e => { e.preventDefault(); onChange(""); }}
          style={{ position: "absolute", right: helpContent ? 22 : 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: C.textMuted, fontSize: 15, lineHeight: 1, padding: 0, zIndex: 1 }}>
          ×
        </button>
      )}
      {/* Help */}
      {helpContent && (
        <div ref={helpRef} style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", zIndex: 2 }}>
          <button onMouseDown={e => { e.preventDefault(); setShowHelp(v => !v); }}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 10, color: C.textMuted, fontFamily: "inherit", padding: "0 2px", fontWeight: 600, opacity: focused || hasVal ? 1 : 0.5 }}>
            ?
          </button>
          {showHelp && (
            <div style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: "0 4px 20px rgba(0,0,0,0.12)", zIndex: 50, width: 300, padding: "14px 16px" }}>
              {helpContent}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Duration formatter (ms → human) ─────────────────────────────────────────
function fmtMs(ms: number): string {
  if (ms < 1000)     return `${ms}ms`;
  if (ms < 60000)    return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000)  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ─── Mini sparkline SVG ───────────────────────────────────────────────────────
function MiniSparkline({ data, color }: { data: number[]; color: string }) {
  const max = Math.max(...data, 1);
  const w = 80, h = 28;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / max) * h}`).join(" ");
  return (
    <svg width={w} height={h} style={{ display: "block", flexShrink: 0 }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.8" />
      <polyline points={`0,${h} ${pts} ${w},${h}`} fill={color} fillOpacity="0.1" stroke="none" />
    </svg>
  );
}

// ─── Stats Bar ────────────────────────────────────────────────────────────────
function StatsBar({ events, eventsTotal, policies, eventStats }: {
  events: EventGroupSummary[];
  eventsTotal: number;
  policies: Policy[];
  eventStats?: EventStats | null;
}) {
  const total      = eventStats ? eventStats.totalGroups  : eventsTotal;
  const completed  = eventStats ? eventStats.completed    : events.filter(e => e.status === "completed").length;
  const inProgress = eventStats ? eventStats.inProgress   : events.filter(e => e.status === "in_progress").length;
  const timedOut   = eventStats ? eventStats.timedOut     : events.filter(e => e.status === "timed_out").length;
  const segments   = eventStats ? eventStats.totalSegments: events.reduce((a, e) => a + e.segmentCount, 0);
  const compRate   = total ? Math.round((completed  / total) * 100) : 0;
  const ipRate     = total ? Math.round((inProgress / total) * 100) : 0;
  const toRate     = total ? Math.round((timedOut   / total) * 100) : 0;

  const cells = [
    { label: "Event Groups", value: String(total),              sub: null,                    color: C.text    },
    { label: "Completed",    value: String(completed),          sub: `${compRate}% of total`, color: C.accent  },
    { label: "In Progress",  value: String(inProgress),         sub: `${ipRate}% of total`,   color: C.warn    },
    { label: "Timed Out",    value: String(timedOut),           sub: timedOut > 0 ? `${toRate}% of total` : null, color: timedOut > 0 ? C.timeout : C.textMuted },
    { label: "Policies",     value: String(policies.length),    sub: null,                    color: C.purple  },
    { label: "Segments",     value: String(segments),           sub: null,                    color: C.info    },
  ];
  return (
    <div style={{ display: "flex", gap: 1, marginBottom: 20 }}>
      {cells.map(c => (
        <div key={c.label} style={{ flex: 1, background: C.surface, border: `1px solid ${C.border}`, padding: "12px 16px" }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: c.color, fontFamily: "monospace", letterSpacing: "-0.02em", lineHeight: 1 }}>{c.value}</div>
          <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginTop: 3 }}>{c.label}</div>
          {c.sub && <div style={{ fontSize: 10, color: c.color, marginTop: 3, opacity: 0.7 }}>{c.sub}</div>}
        </div>
      ))}
    </div>
  );
}

// ─── Status Multi-Select ─────────────────────────────────────────────────────
const STATUS_OPTIONS = [
  { value: "completed",   label: "Completed",   color: C.accent  },
  { value: "in_progress", label: "In Progress", color: C.warn    },
  { value: "timed_out",   label: "Timed Out",   color: C.timeout },
];

function StatusMultiSelect({ selected, onChange }: {
  selected: string[]; onChange: (v: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function handler(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const allSelected = selected.length === 0;
  const isFiltered  = !allSelected;

  function toggle(value: string) {
    if (allSelected) {
      onChange(STATUS_OPTIONS.map(s => s.value).filter(v => v !== value));
    } else if (selected.includes(value)) {
      const next = selected.filter(s => s !== value);
      onChange(next.length === STATUS_OPTIONS.length ? [] : next);
    } else {
      const next = [...selected, value];
      onChange(next.length === STATUS_OPTIONS.length ? [] : next);
    }
  }

  function isIncluded(value: string) { return allSelected || selected.includes(value); }

  function buttonLabel() {
    if (allSelected) return "All statuses";
    if (selected.length === 1) return STATUS_OPTIONS.find(s => s.value === selected[0])?.label ?? "1 status";
    return `${selected.length} statuses`;
  }

  const activeColor = !allSelected && selected.length === 1
    ? STATUS_OPTIONS.find(s => s.value === selected[0])?.color ?? C.accent
    : C.accent;

  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ display: "flex", alignItems: "center", gap: 6, border: `1px solid ${isFiltered ? activeColor + "80" : C.border}`, borderRadius: 6, padding: "6px 10px", fontSize: 12, fontFamily: "inherit", fontWeight: isFiltered ? 600 : 400, color: isFiltered ? activeColor : C.textMid, background: isFiltered ? activeColor + "14" : C.surfaceAlt, cursor: "pointer", outline: "none", whiteSpace: "nowrap" as const, transition: "all 0.15s" }}>
        {buttonLabel()}
        {isFiltered && <span style={{ width: 6, height: 6, borderRadius: "50%", background: activeColor, display: "inline-block", flexShrink: 0 }} />}
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke={isFiltered ? activeColor : C.textMuted} strokeWidth="2" style={{ flexShrink: 0 }}>
          <path d={open ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"}/>
        </svg>
      </button>

      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 100, width: 200, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: "0 4px 20px rgba(0,0,0,0.12)", overflow: "hidden" }}>
          {/* All row */}
          <div style={{ padding: "6px 12px", borderBottom: `1px solid ${C.border}`, background: C.surfaceAlt, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <button onClick={() => onChange([])}
              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: allSelected ? 700 : 400, color: allSelected ? C.accent : C.textMid, border: "none", background: "none", cursor: "pointer", fontFamily: "inherit", padding: "2px 0" }}>
              <span style={{ width: 13, height: 13, border: `2px solid ${allSelected ? C.accent : C.border}`, borderRadius: 3, background: allSelected ? C.accent : "none", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {allSelected && <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="#fff" strokeWidth="2"><path d="M1.5 5l2.5 2.5 4.5-4"/></svg>}
              </span>
              All statuses
            </button>
            {isFiltered && <button onClick={() => { onChange([]); setOpen(false); }} style={{ fontSize: 11, color: C.textMuted, border: "none", background: "none", cursor: "pointer", fontFamily: "inherit" }}>Clear</button>}
          </div>

          {/* Status options */}
          {STATUS_OPTIONS.map(opt => {
            const checked = isIncluded(opt.value);
            return (
              <button key={opt.value} onClick={() => toggle(opt.value)}
                style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", border: "none", background: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left" as const }}
                onMouseEnter={e => (e.currentTarget.style.background = C.surfaceAlt)}
                onMouseLeave={e => (e.currentTarget.style.background = "none")}>
                <span style={{ width: 14, height: 14, border: `2px solid ${checked ? opt.color : C.border}`, borderRadius: 3, background: checked ? opt.color : "none", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "all 0.1s" }}>
                  {checked && <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="#fff" strokeWidth="2"><path d="M1.5 5l2.5 2.5 4.5-4"/></svg>}
                </span>
                <span style={{ fontSize: 12, color: checked ? opt.color : C.textMuted, fontWeight: checked ? 600 : 400 }}>{opt.label}</span>
              </button>
            );
          })}

          {/* Footer count */}
          {isFiltered && (
            <div style={{ padding: "6px 12px", borderTop: `1px solid ${C.border}`, background: C.surfaceAlt, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 10, color: C.textMuted }}>{selected.length} of {STATUS_OPTIONS.length} selected</span>
              <button onClick={() => setOpen(false)} style={{ padding: "3px 10px", background: C.accent, border: "none", borderRadius: 4, color: "#fff", fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Apply</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Change Password Screen ───────────────────────────────────────────────────
function ChangePasswordScreen({ user, onChanged }: { user: import("./api").SessionUser; onChanged: () => void }) {
  const [cur,  setCur]  = useState("");
  const [next, setNext] = useState("");
  const [conf, setConf] = useState("");
  const [err,  setErr]  = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    if (!cur)             { setErr("Enter your current password"); return; }
    if (next.length < 6)  { setErr("New password must be at least 6 characters"); return; }
    if (next !== conf)    { setErr("Passwords do not match"); return; }
    setBusy(true);
    try {
      await api.auth.changePassword(cur, next);
      onChanged();
    } catch (e: any) { setErr(e.message ?? "Failed to change password"); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ minHeight: "100vh", background: C.dark, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Calibri, sans-serif" }}>
      <div style={{ width: 400, background: C.surface, borderRadius: 16, overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}>
        <div style={{ background: "#1A1916", padding: "24px 32px", display: "flex", alignItems: "center", gap: 12 }}>
          <JawIcon size={30} />
          <div>
            <div style={{ fontSize: 20, fontWeight: 900, color: "#FFFFFF", fontFamily: "Georgia, serif" }}>Aggre<span style={{ color: "#1D6B4E" }}>/</span>Gator</div>
            <div style={{ fontSize: 10, color: C.textMuted, fontFamily: "monospace" }}>event streams, swallowed whole</div>
          </div>
        </div>
        <div style={{ padding: "28px 32px" }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: C.text, marginBottom: 6 }}>Change your password</div>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 20, padding: "8px 12px", background: C.warnLight, borderRadius: 6, border: `1px solid ${C.warn}40` }}>
            ⚠ You are using the default password. Please set a new password before continuing.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {[
              { label: "Current password", val: cur,  set: setCur,  ph: "admin123" },
              { label: "New password",      val: next, set: setNext, ph: "at least 6 characters" },
              { label: "Confirm password",  val: conf, set: setConf, ph: "repeat new password" },
            ].map(f => (
              <div key={f.label}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 5 }}>{f.label}</div>
                <input type="password" value={f.val} onChange={e => { f.set(e.target.value); setErr(""); }}
                  onKeyDown={e => e.key === "Enter" && handleSubmit()} placeholder={f.ph}
                  style={{ width: "100%", padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", color: C.text, background: C.surfaceAlt, outline: "none", boxSizing: "border-box" as const }} />
              </div>
            ))}
            {err && <div style={{ fontSize: 12, color: C.danger, background: C.dangerLight, padding: "8px 12px", borderRadius: 6, border: "1px solid #FCA5A5" }}>{err}</div>}
            <button onClick={handleSubmit} disabled={busy}
              style={{ padding: "11px", background: busy ? C.borderStrong : C.accent, color: "#fff", border: "none", borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: busy ? "default" : "pointer", fontFamily: "inherit", marginTop: 4, opacity: busy ? 0.75 : 1 }}>
              {busy ? "Saving…" : "Set new password"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Login Screen ─────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }: { onLogin: (username: string, password: string) => Promise<void> }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error,    setError]    = useState("");
  const [busy,     setBusy]     = useState(false);

  async function handleSubmit() {
    if (!username.trim() || !password) { setError("Enter username and password"); return; }
    setBusy(true);
    try {
      await onLogin(username.trim(), password);
    } catch (e: any) {
      setError(e.message ?? "Login failed");
    } finally { setBusy(false); }
  }

  return (
    <div style={{ minHeight: "100vh", background: C.dark, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Calibri, sans-serif" }}>
      <div style={{ width: 380, background: C.surface, borderRadius: 16, overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}>
        {/* Header */}
        <div style={{ background: "#1A1916", padding: "28px 32px 22px", display: "flex", alignItems: "center", gap: 12 }}>
          <JawIcon size={34} />
          <div>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#FFFFFF", fontFamily: "Georgia, serif", letterSpacing: "-0.02em" }}>
              Aggre<span style={{ color: "#1D6B4E" }}>/</span>Gator
            </div>
            <div style={{ fontSize: 11, color: "#8A8680", fontFamily: "monospace", marginTop: 2 }}>event streams, swallowed whole</div>
          </div>
        </div>
        {/* Form */}
        <div style={{ padding: "28px 32px", background: C.surface }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: C.text, marginBottom: 20 }}>Sign in</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 5 }}>Username</div>
              <input value={username} onChange={e => { setUsername(e.target.value); setError(""); }}
                onKeyDown={e => e.key === "Enter" && handleSubmit()} placeholder="admin" autoFocus
                style={{ width: "100%", padding: "9px 12px", border: `1.5px solid ${C.border}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", color: C.text, background: C.surfaceAlt, outline: "none", boxSizing: "border-box" as const }} />
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 5 }}>Password</div>
              <input type="password" value={password} onChange={e => { setPassword(e.target.value); setError(""); }}
                onKeyDown={e => e.key === "Enter" && handleSubmit()} placeholder="••••••••"
                style={{ width: "100%", padding: "9px 12px", border: `1.5px solid ${C.border}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", color: C.text, background: C.surfaceAlt, outline: "none", boxSizing: "border-box" as const }} />
            </div>
            {error && <div style={{ fontSize: 12, color: C.danger, background: C.dangerLight, padding: "8px 12px", borderRadius: 6, border: `1px solid #FCA5A5` }}>{error}</div>}
            <button onClick={handleSubmit} disabled={busy}
              style={{ padding: "11px", background: busy ? C.borderStrong : C.accent, color: "#fff", border: "none", borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: busy ? "default" : "pointer", fontFamily: "inherit", marginTop: 4, opacity: busy ? 0.75 : 1 }}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </div>
          <div style={{ marginTop: 16, fontSize: 11, color: C.textMuted, textAlign: "center" }}>
            Default credentials: <code style={{ fontFamily: "monospace", color: C.textMid }}>admin / admin123</code>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── SNMP Panel ───────────────────────────────────────────────────────────────
function SnmpPanel({ onBack, policies }: { onBack: () => void; policies: Policy[] }) {
  const [tab,     setTab]     = useState<"status"|"sources"|"rules"|"log">("status");
  const [status,  setStatus]  = useState<any>(null);
  const [sources, setSources] = useState<any[]>([]);
  const [rules,   setRules]   = useState<any[]>([]);
  const [log,     setLog]     = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  React.useEffect(() => {
    loadTab(tab);
  }, [tab]);

  async function loadTab(t: string) {
    setLoading(true);
    try {
      if (t === "status")  setStatus(await api.snmp.status());
      if (t === "sources") setSources(await api.snmp.sources.list());
      if (t === "rules")   setRules(await api.snmp.rules.list());
      if (t === "log")     setLog(await api.snmp.log());
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }

  const tabStyle = (t: string) => ({
    padding: "5px 10px", border: "none", background: tab === t ? C.accentLight : "none",
    color: tab === t ? C.accent : C.textMid, cursor: "pointer", fontSize: 11,
    fontWeight: tab === t ? 700 : 400, fontFamily: "inherit", borderBottom: tab === t ? `2px solid ${C.accent}` : "2px solid transparent",
  });

  return (
    <div>
      <div style={{ padding: "10px 14px", borderBottom: `1px solid ${C.border}`, background: C.surfaceAlt, display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", color: C.textMuted, fontSize: 20, padding: 0, lineHeight: 1 }}>‹</button>
        <span style={{ fontSize: 13, fontWeight: 800, flex: 1 }}>📡 SNMP Trap Receiver</span>
        <button onClick={() => loadTab(tab)} style={{ fontSize: 11, color: C.accent, background: "none", border: `1px solid ${C.accentSoft}`, borderRadius: 4, padding: "2px 8px", cursor: "pointer", fontFamily: "inherit" }}>↻</button>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, background: C.surface }}>
        {(["status","sources","rules","log"] as const).map(t => (
          <button key={t} style={tabStyle(t)} onClick={() => setTab(t)}>{t.charAt(0).toUpperCase()+t.slice(1)}</button>
        ))}
      </div>

      <div style={{ maxHeight: 380, overflowY: "auto" }}>
        {loading && <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: C.textMuted }}>Loading…</div>}

        {!loading && tab === "status" && status && (
          <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ padding: "10px 14px", borderRadius: 8, background: status.enabled ? C.accentLight : C.surfaceAlt, border: `1px solid ${status.enabled ? C.accentSoft : C.border}` }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: status.enabled ? C.accent : C.textMid }}>
                {status.enabled ? "● Receiver Active" : "○ Receiver Disabled"}
              </div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3 }}>
                UDP port {status.port} · Community: <code style={{ fontFamily: "monospace" }}>{status.community}</code>
              </div>
              {!status.enabled && (
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6, padding: "6px 8px", background: C.surfaceDeep, borderRadius: 5 }}>
                  Set <code style={{ fontFamily: "monospace" }}>SNMP_ENABLED=true</code> env var and rebuild to enable
                </div>
              )}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {[
                { label: "Received", value: status.received, color: C.info },
                { label: "Routed",   value: status.routed,   color: C.accent },
                { label: "Unrouted", value: status.unrouted, color: C.warn },
                { label: "Errors",   value: status.errors,   color: C.danger },
              ].map(s => (
                <div key={s.label} style={{ padding: "8px 10px", background: C.surfaceAlt, borderRadius: 6, border: `1px solid ${C.border}` }}>
                  <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "monospace", color: s.color }}>{s.value}</div>
                  <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.07em" }}>{s.label}</div>
                </div>
              ))}
            </div>
            <div style={{ padding: "10px 12px", background: C.surfaceAlt, borderRadius: 6, border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, marginBottom: 5, letterSpacing: "0.07em" }}>AggreGator MIB OIDs</div>
              {[
                { name: "Ingest trap",    oid: "1.3.6.1.4.1.99999.2.1" },
                { name: "agPolicyId",     oid: "1.3.6.1.4.1.99999.4.1" },
                { name: "agAggregKey",    oid: "1.3.6.1.4.1.99999.4.2" },
                { name: "agEventType",    oid: "1.3.6.1.4.1.99999.4.3" },
                { name: "agEventBody",    oid: "1.3.6.1.4.1.99999.4.4" },
              ].map(r => (
                <div key={r.oid} style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginBottom: 2 }}>
                  <span style={{ color: C.textMid }}>{r.name}</span>
                  <code style={{ fontFamily: "monospace", color: C.textMuted, fontSize: 9 }}>{r.oid}</code>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11, color: C.textMuted, padding: "8px 10px", background: C.surfaceAlt, borderRadius: 6, fontFamily: "monospace" }}>
              Test: node scripts/send-trap.js --policy &lt;uuid&gt; --key K-001 --event-type test.event
            </div>
          </div>
        )}

        {!loading && tab === "sources" && (
          <div>
            {sources.length === 0 && <div style={{ padding: 20, textAlign: "center", fontSize: 12, color: C.textMuted }}>No trap sources seen yet. Sources are auto-registered when a trap arrives.</div>}
            {sources.map((s: any) => (
              <div key={s.id} style={{ padding: "10px 14px", borderBottom: `1px solid ${C.border}`, opacity: s.is_active ? 1 : 0.55 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 2 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{s.name !== s.agent_addr ? s.name : s.agent_addr}</span>
                  <span style={{ fontSize: 10, fontFamily: "monospace", color: C.textMuted }}>{s.agent_addr}</span>
                  <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: C.infoLight, color: C.info, fontWeight: 700 }}>{s.community}</span>
                </div>
                <div style={{ fontSize: 10, color: C.textMuted }}>
                  {s.trap_count} traps · Last seen: {s.last_seen ? new Date(s.last_seen).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "Never"}
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && tab === "rules" && (
          <div>
            {rules.length === 0 && (
              <div style={{ padding: "16px 14px" }}>
                <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10 }}>No routing rules configured. AggreGator MIB traps route automatically via their agPolicyId varbind. Rules are for standard third-party traps.</div>
              </div>
            )}
            {rules.map((r: any) => (
              <div key={r.id} style={{ padding: "10px 14px", borderBottom: `1px solid ${C.border}` }}>
                <div style={{ display: "flex", gap: 5, alignItems: "center", marginBottom: 3 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: C.surfaceDeep, color: C.textMid }}>P{r.priority}</span>
                  {r.match_community && <span style={{ fontSize: 10, fontFamily: "monospace", background: C.infoLight, color: C.info, padding: "1px 5px", borderRadius: 3 }}>community={r.match_community}</span>}
                  {r.match_agent && <span style={{ fontSize: 10, fontFamily: "monospace", background: C.infoLight, color: C.info, padding: "1px 5px", borderRadius: 3 }}>{r.match_agent}</span>}
                  {r.match_trap_oid && <span style={{ fontSize: 10, fontFamily: "monospace", color: C.textMuted }}>{r.match_trap_oid}</span>}
                </div>
                <div style={{ fontSize: 11, color: C.textMid }}>→ <strong>{r.policy_name}</strong> · key: <code style={{ fontFamily: "monospace" }}>{r.key_field}</code></div>
              </div>
            ))}
            <div style={{ padding: "8px 14px", background: C.surfaceAlt, fontSize: 10, color: C.textMuted }}>
              Add rules via <code style={{ fontFamily: "monospace" }}>POST /api/v1/snmp/rules</code>
            </div>
          </div>
        )}

        {!loading && tab === "log" && (
          <div>
            {log.length === 0 && <div style={{ padding: 20, textAlign: "center", fontSize: 12, color: C.textMuted }}>No traps received yet.</div>}
            {log.map((entry: any) => (
              <div key={entry.id} style={{ padding: "8px 14px", borderBottom: `1px solid ${C.border}`, fontSize: 11 }}>
                <div style={{ display: "flex", gap: 5, alignItems: "center", marginBottom: 2 }}>
                  <span style={{ fontFamily: "monospace", fontWeight: 700, color: entry.route_type === "unrouted" ? C.warn : C.accent, fontSize: 10 }}>{entry.trap_name ?? entry.trap_oid}</span>
                  <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: entry.route_type === "aggregator_mib" ? C.accentLight : entry.route_type === "unrouted" ? C.warnLight : C.infoLight, color: entry.route_type === "aggregator_mib" ? C.accent : entry.route_type === "unrouted" ? C.warn : C.info, fontWeight: 700 }}>{entry.route_type}</span>
                </div>
                <div style={{ color: C.textMuted }}>
                  {entry.agent_addr} · {new Date(entry.received_at).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Burger Menu ──────────────────────────────────────────────────────────────
function BurgerMenu({ user, policies, appUsers, onSignOut, onUsersChanged, onOpenPolicies }: {
  user: import("./api").SessionUser;
  policies: Policy[];
  appUsers: import("./api").AppUser[];
  onSignOut: () => void;
  onUsersChanged: () => void;
  onOpenPolicies: () => void;
}) {
  const [open,    setOpen]    = useState(false);
  const [section, setSection] = useState<null | "policies" | "accounts" | "snmp">(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newU,    setNewU]    = useState({ username: "", email: "", password: "", role: "viewer" });
  const [saving,  setSaving]  = useState(false);
  const [err,     setErr]     = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false); setSection(null); setShowAdd(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const rc: Record<string, string> = { admin: C.danger, editor: C.warn, viewer: C.info };
  const rb: Record<string, string> = { admin: C.dangerLight, editor: C.warnLight, viewer: C.infoLight };

  async function createUser() {
    if (!newU.username.trim() || !newU.email.trim() || !newU.password) { setErr("All fields required"); return; }
    setSaving(true); setErr("");
    try {
      await api.auth.users.create(newU);
      setNewU({ username: "", email: "", password: "", role: "viewer" });
      setShowAdd(false);
      onUsersChanged();
    } catch (e: any) { setErr(e.message ?? "Failed to create user"); }
    finally { setSaving(false); }
  }

  async function toggleUser(id: string, isActive: boolean) {
    await api.auth.users.update(id, { isActive: !isActive }).catch(() => {});
    onUsersChanged();
  }

  async function removeUser(id: string) {
    await api.auth.users.delete(id).catch(() => {});
    onUsersChanged();
  }

  return (
    <div ref={menuRef} style={{ position: "relative" }}>
      <button onClick={() => { setOpen(o => !o); setSection(null); setShowAdd(false); setErr(""); }}
        style={{ width: 36, height: 36, border: `1px solid ${open ? C.accent : C.border}`, borderRadius: 7, background: open ? C.accentLight : C.surface, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, padding: 0 }}
        title="Menu">
        {[0,1,2].map(i => (
          <div key={i} style={{ width: 16, height: 2, background: open ? C.accent : C.textMid, borderRadius: 1, transition: "all 0.15s",
            transform: open ? (i===0 ? "rotate(45deg) translate(4px,4px)" : i===2 ? "rotate(-45deg) translate(4px,-4px)" : "scaleX(0)") : "none",
            opacity: open && i===1 ? 0 : 1 }} />
        ))}
      </button>

      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 8px)", right: 0, width: section ? 400 : 220, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.14)", zIndex: 200, overflow: "hidden" }}>

          {!section && (
            <div>
              <div style={{ padding: "10px 14px", borderBottom: `1px solid ${C.border}`, background: C.surfaceAlt }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: C.text }}>{user.username}</div>
                <span style={{ background: rb[user.role] ?? C.infoLight, color: rc[user.role] ?? C.info, fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 3 }}>{user.role}</span>
              </div>
              {[
                ...(user.role !== "viewer" ? [{ icon: "⚙", label: "Policies",  desc: "Manage aggregation policies",  s: "policies" as const }] : []),
                ...(user.role === "admin"  ? [{ icon: "👤", label: "Accounts", desc: "Add, remove, disable users", s: "accounts" as const }] : []),
                { icon: "📡", label: "SNMP",      desc: "Trap receiver & routing rules", s: "snmp" as const },
              ].map(item => (
                <button key={item.s} onClick={() => setSection(item.s)}
                  style={{ width: "100%", padding: "11px 14px", border: "none", borderBottom: `1px solid ${C.border}`, background: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left" as const, display: "flex", gap: 10, alignItems: "center" }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = C.surfaceAlt; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "none"; }}>
                  <span style={{ fontSize: 16, width: 22, textAlign: "center" as const }}>{item.icon}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{item.label}</div>
                    <div style={{ fontSize: 10, color: C.textMuted }}>{item.desc}</div>
                  </div>
                  <span style={{ color: C.textMuted }}>›</span>
                </button>
              ))}
              <button onClick={onSignOut}
                style={{ width: "100%", padding: "10px 14px", border: "none", background: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left" as const, display: "flex", gap: 10, alignItems: "center", color: C.danger, fontSize: 12, fontWeight: 600 }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = C.dangerLight; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "none"; }}>
                <span style={{ fontSize: 16, width: 22, textAlign: "center" as const }}>⏻</span>
                Sign out
              </button>
            </div>
          )}

          {section === "accounts" && (
            <div>
              <div style={{ padding: "10px 14px", borderBottom: `1px solid ${C.border}`, background: C.surfaceAlt, display: "flex", alignItems: "center", gap: 8 }}>
                <button onClick={() => { setSection(null); setShowAdd(false); setErr(""); }}
                  style={{ background: "none", border: "none", cursor: "pointer", color: C.textMuted, fontSize: 20, padding: 0, lineHeight: 1 }}>‹</button>
                <span style={{ fontSize: 13, fontWeight: 800, flex: 1 }}>Accounts</span>
                <button onClick={() => { setShowAdd(s => !s); setErr(""); }}
                  style={{ padding: "4px 10px", background: showAdd ? C.borderStrong : C.accent, color: "#fff", border: "none", borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                  {showAdd ? "Cancel" : "+ Add"}
                </button>
              </div>
              {showAdd && (
                <div style={{ padding: "12px 14px", borderBottom: `1px solid ${C.border}`, background: C.accentLight + "80", display: "flex", flexDirection: "column", gap: 7 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.accent }}>New account</div>
                  {([["Username","username","text"],["Email","email","email"],["Password","password","password"]] as [string,string,string][]).map(([lbl,key,type]) => (
                    <input key={key} type={type} value={(newU as any)[key]} placeholder={lbl.toLowerCase()}
                      onChange={e => setNewU(n => ({ ...n, [key]: e.target.value }))}
                      style={{ padding: "6px 8px", border: `1px solid ${C.border}`, borderRadius: 5, fontSize: 11, fontFamily: "inherit", outline: "none", width: "100%", boxSizing: "border-box" as const }} />
                  ))}
                  <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                    <span style={{ fontSize: 11, color: C.textMuted }}>Role:</span>
                    {(["viewer","editor","admin"] as const).map(r => (
                      <button key={r} onClick={() => setNewU(n => ({ ...n, role: r }))}
                        style={{ padding: "3px 8px", fontSize: 10, fontWeight: newU.role === r ? 700 : 400, border: `1px solid ${newU.role === r ? rc[r] : C.border}`, borderRadius: 4, background: newU.role === r ? rb[r] : "none", color: newU.role === r ? rc[r] : C.textMid, cursor: "pointer", fontFamily: "inherit" }}>
                        {r}
                      </button>
                    ))}
                  </div>
                  {err && <div style={{ fontSize: 11, color: C.danger }}>{err}</div>}
                  <button onClick={createUser} disabled={saving}
                    style={{ padding: "7px", background: C.accent, color: "#fff", border: "none", borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                    {saving ? "Creating…" : "Create account"}
                  </button>
                </div>
              )}
              <div style={{ maxHeight: 320, overflowY: "auto" }}>
                {appUsers.map(u => (
                  <div key={u.id} style={{ padding: "10px 14px", borderBottom: `1px solid ${C.border}`, display: "flex", gap: 10, alignItems: "center", opacity: u.isActive ? 1 : 0.55 }}>
                    <div style={{ width: 30, height: 30, borderRadius: "50%", background: u.isActive ? C.accent : C.borderStrong, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
                      {u.username[0].toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{u.username}</span>
                        <span style={{ background: rb[u.role], color: rc[u.role], fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3 }}>{u.role}</span>
                        {!u.isActive && <span style={{ fontSize: 9, color: C.textMuted, fontStyle: "italic" }}>disabled</span>}
                      </div>
                      <div style={{ fontSize: 10, color: C.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{u.email}</div>
                      <div style={{ fontSize: 10, color: C.textMuted }}>Last login: {u.lastLogin ? new Date(u.lastLogin).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "Never"}</div>
                    </div>
                    <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                      <button onClick={() => toggleUser(u.id, u.isActive)}
                        style={{ padding: "3px 7px", border: `1px solid ${C.border}`, borderRadius: 4, background: "none", cursor: "pointer", fontSize: 10, color: u.isActive ? C.warn : C.accent, fontFamily: "inherit" }}>
                        {u.isActive ? "Disable" : "Enable"}
                      </button>
                      {u.username !== user.username && (
                        <button onClick={() => removeUser(u.id)}
                          style={{ padding: "3px 7px", border: `1px solid ${C.danger}40`, borderRadius: 4, background: "none", cursor: "pointer", fontSize: 10, color: C.danger, fontFamily: "inherit" }}>
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ padding: "7px 14px", background: C.surfaceAlt, fontSize: 10, color: C.textMuted }}>
                viewer = read only · editor = ingest + policies · admin = full access
              </div>
            </div>
          )}

          {section === "policies" && (
            <div>
              <div style={{ padding: "10px 14px", borderBottom: `1px solid ${C.border}`, background: C.surfaceAlt, display: "flex", alignItems: "center", gap: 8 }}>
                <button onClick={() => setSection(null)}
                  style={{ background: "none", border: "none", cursor: "pointer", color: C.textMuted, fontSize: 20, padding: 0, lineHeight: 1 }}>‹</button>
                <span style={{ fontSize: 13, fontWeight: 800, flex: 1 }}>Policies</span>
                <span style={{ fontSize: 10, color: C.textMuted }}>{policies.length} total</span>
              </div>
              <div style={{ maxHeight: 360, overflowY: "auto" }}>
                {policies.map(p => (
                  <div key={p.id} style={{ padding: "10px 14px", borderBottom: `1px solid ${C.border}`, display: "flex", gap: 10, alignItems: "center" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", gap: 5, alignItems: "center", marginBottom: 2 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{p.name.replace("EXAMPLE - ", "")}</span>
                        <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, fontWeight: 700, background: p.isActive ? C.accentLight : C.surfaceDeep, color: p.isActive ? C.accent : C.textMuted, border: `1px solid ${p.isActive ? C.accentSoft : C.border}` }}>
                          {p.isActive ? "● Active" : "○ Inactive"}
                        </span>
                        {p.timeoutMs && <span style={{ fontSize: 9, color: C.timeout, background: C.timeoutLight, padding: "1px 5px", borderRadius: 3, fontWeight: 700 }}>⏱ {fmtMs(p.timeoutMs)}</span>}
                      </div>
                      <div style={{ fontSize: 10, color: C.textMuted, fontFamily: "monospace" }}>{p.keyField} · {p.cradleValue} → {p.graveValue}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ padding: "8px 14px", background: C.surfaceAlt }}>
                <button onClick={() => { setOpen(false); setSection(null); onOpenPolicies(); }}
                  style={{ fontSize: 11, color: C.accent, background: "none", border: `1px solid ${C.accentSoft}`, borderRadius: 5, padding: "4px 12px", cursor: "pointer", fontFamily: "inherit", width: "100%" }}>
                  Open full Policy Editor →
                </button>
              </div>
            </div>
          )}

          {section === "snmp" && (
            <SnmpPanel onBack={() => setSection(null)} policies={policies} />
          )}

        </div>
      )}
    </div>
  );
}

// ─── Aggre/Gator logo icon — jaw variant A, forest colour ────────────────────
function JawIcon({ size = 32 }: { size?: number }) {
  const color = C.accent;
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 6 L32 15 L32 19 L4 11Z" fill={color}/>
      <path d="M4 30 L32 19 L32 24 L4 35Z" fill={color} opacity="0.5"/>
      <circle cx="29" cy="12" r="4" fill={C.surface} opacity="0.25"/>
      <circle cx="29" cy="12" r="2.5" fill={C.surface}/>
      <circle cx="29.5" cy="12.3" r="1" fill={color} opacity="0.4"/>
      <ellipse cx="29.7" cy="12.4" rx="0.45" ry="0.95" fill="#1A1916"/>
    </svg>
  );
}

// ─── Highlighted group state ──────────────────────────────────────────────────
interface HighlightedGroup { id: string; reason: "new" | "promoted" | "segment"; }

// ─── Pie chart slices component ──────────────────────────────────────────────
function PieSlices({ data, hovered, setHovered }: { data: { label: string; value: number; color: string }[]; hovered: number | null; setHovered: (i: number | null) => void }) {
  const total = data.reduce((a, d) => a + d.value, 0);
  if (total === 0) return null;
  const W = 220, CX = 110, CY = 110, R = 88;
  let cum = -Math.PI / 2;
  const slices = data.map((d, i) => {
    const angle = (d.value / total) * 2 * Math.PI;
    const start = cum; cum += angle; const end = cum;
    const large = angle > Math.PI ? 1 : 0;
    const cos = Math.cos, sin = Math.sin;
    const path = `M ${CX} ${CY} L ${CX+R*cos(start)} ${CY+R*sin(start)} A ${R} ${R} 0 ${large} 1 ${CX+R*cos(end)} ${CY+R*sin(end)} Z`;
    const mid = start + angle / 2;
    const lr = R * 0.62;
    const pct = Math.round((d.value / total) * 100);
    return { ...d, path, pct, lx: CX+lr*cos(mid), ly: CY+lr*sin(mid) };
  });
  const isH = hovered !== null;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
      <svg width={W} height={W} viewBox={`0 0 ${W} ${W}`} style={{ display: "block", overflow: "visible" }}>
        {slices.map((s, i) => {
          const isThis = hovered === i;
          return (
            <g key={s.label} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)} style={{ cursor: "pointer" }}>
              <path d={s.path} fill={s.color} opacity={isH && !isThis ? 0.28 : 0.88} stroke={C.surface} strokeWidth="2"
                style={{ transform: isThis ? "scale(1.03)" : "scale(1)", transformOrigin: `${CX}px ${CY}px`, transition: "all 0.15s" }} />
              {s.pct >= 5 && (
                <text x={s.lx} y={s.ly} textAnchor="middle" dominantBaseline="middle" fontSize={isThis ? "12" : "11"} fontWeight="800" fill="#fff" fontFamily="monospace" opacity={isH && !isThis ? 0.4 : 1} style={{ pointerEvents: "none", transition: "all 0.15s" }}>{s.pct}%</text>
              )}
            </g>
          );
        })}
        <circle cx={CX} cy={CY} r="3" fill={C.surface} opacity="0.6" />
      </svg>
      <div style={{ marginTop: 6, textAlign: "center" as const }}>
        <div style={{ fontFamily: "monospace", fontWeight: 800, fontSize: 18, color: isH && hovered !== null ? data[hovered].color : C.text, transition: "color 0.15s" }}>
          {isH && hovered !== null
            ? <>{data[hovered].value.toLocaleString()}<span style={{ fontSize: 12, color: C.textMuted, fontWeight: 400 }}> / {total.toLocaleString()}</span></>
            : total.toLocaleString()
          }
        </div>
        <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>{isH && hovered !== null ? data[hovered].label : "total"}</div>
      </div>
    </div>
  );
}

// ─── Heatmap chart ────────────────────────────────────────────────────────────
function HeatmapChart({ tp }: { tp: { bucket: string; opened: number; closed: number }[] }) {
  const HOURS = Array.from({ length: 24 }, (_, i) => i);
  const DAYS  = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  // Build a 7×24 grid from the throughput data — use bucket timestamps to assign
  // If insufficient real data, fill with zeros
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  tp.forEach(b => {
    const d = new Date(b.bucket);
    const dow = (d.getDay() + 6) % 7; // Mon=0
    const hr  = d.getHours();
    grid[dow][hr] = (grid[dow][hr] ?? 0) + b.opened;
  });
  const maxVal = Math.max(...grid.flat(), 1);

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: C.textMid, textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 12 }}>
        Hourly Activity Heatmap — Groups Opened
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "32px repeat(24, 1fr)", gap: 2, alignItems: "center" }}>
        {/* Hour labels */}
        <div />
        {HOURS.map(h => (
          <div key={h} style={{ fontSize: 8, color: C.textMuted, textAlign: "center" as const, fontFamily: "monospace" }}>
            {h % 4 === 0 ? String(h).padStart(2, "0") : ""}
          </div>
        ))}
        {/* Rows */}
        {DAYS.map((day, di) => (
          <>
            <div key={day + "-label"} style={{ fontSize: 9, color: C.textMuted }}>{day}</div>
            {HOURS.map(h => {
              const v    = grid[di][h];
              const norm = v / maxVal;
              return (
                <div key={h} title={`${day} ${String(h).padStart(2, "0")}:00 — ${v} groups opened`}
                  style={{ height: 16, borderRadius: 2, background: `rgba(29,107,78,${0.07 + norm * 0.85})`, cursor: "default" }} />
              );
            })}
          </>
        ))}
      </div>
      <div style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 10, justifyContent: "flex-end" }}>
        <span style={{ fontSize: 9, color: C.textMuted }}>Low</span>
        {[0.07, 0.25, 0.45, 0.65, 0.87].map(o => (
          <div key={o} style={{ width: 14, height: 10, borderRadius: 2, background: `rgba(29,107,78,${o})` }} />
        ))}
        <span style={{ fontSize: 9, color: C.textMuted }}>High</span>
      </div>
    </div>
  );
}

// ─── Reports — Overview ───────────────────────────────────────────────────────
// ─── Audit Log View ───────────────────────────────────────────────────────────
function AuditLogView() {
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter,  setFilter]  = useState<{ action: string; actor: string }>({ action: "", actor: "" });

  React.useEffect(() => {
    setLoading(true);
    api.audit.list({ limit: 500 }).then(setEntries).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const actionColors: Record<string, string> = {
    "user.login": C.accent, "user.logout": C.textMuted, "user.created": C.info,
    "user.updated": C.info, "user.deleted": C.danger, "user.password_changed": C.purple,
    "policy.created": C.accent, "policy.updated": C.warn, "policy.deleted": C.danger,
    "policy.toggled": C.info, "event.ingested": C.textMuted,
    "event.group_opened": C.accent, "event.group_completed": C.purple,
  };

  const filtered = entries.filter(e =>
    (!filter.action || e.action?.includes(filter.action)) &&
    (!filter.actor  || e.actor?.includes(filter.actor))
  );

  return (
    <div style={{ background: C.surface, borderRadius: 10, border: `1px solid ${C.border}`, overflow: "hidden" }}>
      <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" as const }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: C.text, flex: 1 }}>Audit Log</div>
        <input value={filter.action} onChange={e => setFilter(f => ({ ...f, action: e.target.value }))} placeholder="Filter by action…"
          style={{ padding: "5px 10px", border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 11, fontFamily: "monospace", color: C.text, background: C.surfaceAlt, outline: "none", width: 160 }} />
        <input value={filter.actor} onChange={e => setFilter(f => ({ ...f, actor: e.target.value }))} placeholder="Filter by actor…"
          style={{ padding: "5px 10px", border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 11, fontFamily: "monospace", color: C.text, background: C.surfaceAlt, outline: "none", width: 140 }} />
        <button onClick={() => { setLoading(true); api.audit.list({ limit: 500 }).then(setEntries).catch(() => {}).finally(() => setLoading(false)); }}
          style={{ padding: "5px 12px", fontSize: 11, border: `1px solid ${C.border}`, borderRadius: 6, background: "none", cursor: "pointer", fontFamily: "inherit", color: C.textMid }}>↻ Refresh</button>
      </div>
      {loading ? (
        <div style={{ padding: 32, textAlign: "center", color: C.textMuted, fontSize: 13 }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 32, textAlign: "center", color: C.textMuted, fontSize: 13 }}>No audit log entries yet.</div>
      ) : (
        <div style={{ overflowX: "auto" as const }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: C.surfaceAlt, borderBottom: `1px solid ${C.border}` }}>
                {["Time", "Action", "Entity", "Actor", "Source IP", "Details"].map(h => (
                  <th key={h} style={{ padding: "8px 14px", textAlign: "left" as const, fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.07em", whiteSpace: "nowrap" as const }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((e: any, i: number) => (
                <tr key={e.id ?? i} style={{ borderBottom: `1px solid ${C.border}`, background: i % 2 === 0 ? "none" : C.surfaceAlt + "60" }}>
                  <td style={{ padding: "8px 14px", color: C.textMuted, whiteSpace: "nowrap" as const, fontFamily: "monospace", fontSize: 11 }}>
                    {e.event_time ? new Date(e.event_time).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "medium" }) : "—"}
                  </td>
                  <td style={{ padding: "8px 14px", whiteSpace: "nowrap" as const }}>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: (actionColors[e.action] ?? C.textMuted) + "18", color: actionColors[e.action] ?? C.textMuted, fontFamily: "monospace" }}>
                      {e.action ?? "—"}
                    </span>
                  </td>
                  <td style={{ padding: "8px 14px", fontFamily: "monospace", fontSize: 11, color: C.textMid }}>
                    <span style={{ color: C.textMuted }}>{e.entity_type}</span>
                    <span style={{ color: C.textMuted }}>/</span>
                    <span>{String(e.entity_id ?? "").slice(0, 8)}…</span>
                  </td>
                  <td style={{ padding: "8px 14px", fontFamily: "monospace", fontSize: 11, color: C.text }}>{e.actor ?? "—"}</td>
                  <td style={{ padding: "8px 14px", fontFamily: "monospace", fontSize: 11, color: C.textMuted }}>{e.source_ip ?? "—"}</td>
                  <td style={{ padding: "8px 14px", fontSize: 11, color: C.textMuted, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                    {e.aggregation_key ? <span>key: <code style={{ fontFamily: "monospace", color: C.info }}>{e.aggregation_key}</code></span>
                     : e.metadata ? <span style={{ fontFamily: "monospace" }}>{JSON.stringify(e.metadata).slice(0, 60)}</span>
                     : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ padding: "8px 14px", background: C.surfaceAlt, fontSize: 11, color: C.textMuted, borderTop: `1px solid ${C.border}` }}>
            {filtered.length} entries{filtered.length !== entries.length ? ` (${entries.length} total)` : ""}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Reports — Overview ───────────────────────────────────────────────────────
function ReportsOverview({ policies, stats, dateRange, policyFilter }: { policies: Policy[]; stats: EventStats | null; dateRange: string; policyFilter: string[] }) {
  if (!stats) return <div style={{ padding: 48, textAlign: "center", color: C.textMuted }}>Loading…</div>;

  const [grpPinned, setGrpPinned] = useState<number | null>(null);
  const [segPinned, setSegPinned] = useState<number | null>(null);
  const [grpShow, setGrpShow] = useState({ opened: true, closed: true, inProgress: true });
  const [segShow, setSegShow] = useState({ segOpened: true, segClosed: true });
  const [grpHovered, setGrpHovered] = useState<number | null>(null);
  const [segHovered, setSegHovered] = useState<number | null>(null);
  const [pieHovered, setPieHovered] = useState<number | null>(null);

  const tp = stats.throughput;
  const numBuckets = tp.length;
  const labelStep = Math.max(1, Math.floor(numBuckets / 5));

  const rangeSubtitle = { "24h": "hourly buckets", "7d": "6-hour buckets", "30d": "daily buckets", "6m": "daily buckets", "all": "daily buckets" }[dateRange] ?? "daily buckets";
  const rangeLabel    = { "24h": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days", "6m": "last 6 months", "all": "all time" }[dateRange] ?? "selected range";

  // Format bucket label based on date range
  function fmtBucket(bucket: string) {
    const d = new Date(bucket);
    if (dateRange === "24h") return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    if (dateRange === "7d")  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric" });
    return d.toLocaleDateString("en-GB", { month: "short", day: "numeric" });
  }

  function fmtFull(bucket: string) {
    const d = new Date(bucket);
    if (dateRange === "24h") return d.toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });
    return d.toLocaleDateString("en-GB", { dateStyle: "medium" });
  }

  // Tooltip component (inline)
  function ChartTooltip({ idx, data, series, pinned }: { idx: number | null; data: typeof tp; series: { key: string; label: string; color: string; active: boolean; valFn: (b: typeof tp[0]) => number }[]; pinned: boolean }) {
    if (idx === null || !data[idx]) return null;
    const d = data[idx];
    const pct = idx / Math.max(data.length - 1, 1) * 100;
    const goRight = pct < 65;
    return (
      <div style={{ position: "absolute", top: 0, ...(goRight ? { left: `${pct}%`, transform: "translateX(12px)" } : { right: `${100 - pct}%`, transform: "translateX(-12px)" }), background: C.text, color: "#fff", borderRadius: 6, padding: "8px 12px", fontSize: 10, zIndex: 20, pointerEvents: "none", whiteSpace: "nowrap" as const, boxShadow: "0 4px 16px rgba(0,0,0,0.3)", minWidth: 170 }}>
        {pinned && <div style={{ fontSize: 8, opacity: 0.5, marginBottom: 4, textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>● Pinned</div>}
        <div style={{ fontFamily: "monospace", opacity: 0.6, marginBottom: 6, fontSize: 9 }}>{fmtFull(d.bucket)}</div>
        {series.filter(s => s.active).map(s => (
          <div key={s.key} style={{ display: "flex", justifyContent: "space-between", gap: 14, marginBottom: 3 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 7, height: 7, borderRadius: 1, background: s.color, display: "inline-block", flexShrink: 0 }} />{s.label}
            </span>
            <span style={{ fontWeight: 700, fontFamily: "monospace" }}>{s.valFn(d).toLocaleString()}</span>
          </div>
        ))}
      </div>
    );
  }

  // Generic chart renderer
  function renderChart(
    title: string,
    data: typeof tp,
    series: { key: string; label: string; color: string; active: boolean; onToggle: () => void; valFn: (b: typeof tp[0]) => number }[],
    pinned: number | null, setPinned: (i: number | null) => void,
    hovered: number | null, setHovered: (i: number | null) => void
  ) {
    const activeSeries = series.filter(s => s.active);
    const maxVal = Math.max(...data.map(d => Math.max(...activeSeries.map(s => s.valFn(d)), 0)), 1);
    const activeIdx = pinned ?? hovered;

    return (
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 800, color: C.textMid, textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>{title}</div>
            <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2, fontFamily: "monospace" }}>{rangeLabel} · {rangeSubtitle}</div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const, justifyContent: "flex-end", alignItems: "center" }}>
            {series.map(s => (
              <button key={s.key} onClick={s.onToggle}
                style={{ padding: "3px 8px", border: `1px solid ${s.active ? s.color : C.border}`, borderRadius: 20, background: s.active ? s.color + "18" : "none", cursor: "pointer", fontSize: 10, fontWeight: s.active ? 700 : 400, color: s.active ? s.color : C.textMuted, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4, transition: "all 0.15s" }}>
                <span style={{ width: 6, height: 6, borderRadius: 1, background: s.active ? s.color : C.borderStrong, display: "inline-block" }} />{s.label}
              </button>
            ))}
            {pinned !== null && (
              <button onClick={() => setPinned(null)}
                style={{ padding: "3px 8px", border: `1px solid ${C.border}`, borderRadius: 20, background: C.surfaceAlt, cursor: "pointer", fontSize: 10, color: C.textMid, fontFamily: "inherit" }}>
                ✕ unpin
              </button>
            )}
          </div>
        </div>

        {data.length === 0
          ? <div style={{ textAlign: "center", color: C.textMuted, fontSize: 12, padding: "16px 0" }}>No data in current filter window</div>
          : <div style={{ position: "relative" }}>
              <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 80 }}
                onMouseLeave={() => { if (pinned === null) setHovered(null); }}>
                {data.map((b, i) => {
                  const isPinned  = pinned === i;
                  const isActive  = activeIdx === i;
                  const pct = i / Math.max(data.length - 1, 1) * 100;
                  return (
                    <div key={i}
                      onClick={() => setPinned(pinned === i ? null : i)}
                      onMouseEnter={() => { if (pinned === null) setHovered(i); }}
                      style={{ flex: 1, display: "flex", gap: 1, alignItems: "flex-end", cursor: "pointer", position: "relative", outline: isPinned ? `2px solid ${C.accent}40` : "none", outlineOffset: 1, borderRadius: 2 }}>
                      {activeSeries.map(s => (
                        <div key={s.key} style={{ flex: 1, background: s.color, borderRadius: "2px 2px 0 0", height: `${Math.max((s.valFn(b) / maxVal) * 76, s.valFn(b) ? 2 : 0)}px`, opacity: isActive ? 1 : 0.75, transition: "opacity 0.1s" }} />
                      ))}
                    </div>
                  );
                })}
              </div>
              <ChartTooltip idx={activeIdx} data={data} series={series} pinned={pinned !== null} />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                {data.filter((_, i) => i % labelStep === 0).map(b => (
                  <span key={b.bucket} style={{ fontSize: 9, color: C.textMuted, fontFamily: "monospace" }}>{fmtBucket(b.bucket)}</span>
                ))}
              </div>
              <div style={{ marginTop: 5, fontSize: 9, color: C.textMuted, textAlign: "center" as const }}>
                {pinned !== null ? "● Pinned — click same bar or 'unpin' to release" : "Hover to preview · click a bar to pin the tooltip"}
              </div>
            </div>
        }
      </div>
    );
  }

  // Build segment counts from byPolicy (approximation — backend throughput doesn't include segments)
  // We show the same buckets scaled by avg segment count
  const avgSegsPerGroup = stats.totalGroups > 0 ? stats.totalSegments / stats.totalGroups : 2.5;
  const tpWithSegs = tp.map(b => ({
    ...b,
    segOpened: Math.round(b.opened * avgSegsPerGroup),
    segClosed: Math.round(b.closed * avgSegsPerGroup),
  }));

  const polColors: Record<string, string> = {};
  const palette = [C.info, C.accent, C.warn, C.purple];
  policies.forEach((p, i) => { polColors[p.id] = palette[i % palette.length]; });

  const grpSeries = [
    { key: "opened",     label: "Opened",      color: C.accent, active: grpShow.opened,     valFn: (b: typeof tp[0]) => b.opened,     onToggle: () => setGrpShow(s => ({ ...s, opened:     !s.opened     })) },
    { key: "closed",     label: "Closed",      color: C.info,   active: grpShow.closed,     valFn: (b: typeof tp[0]) => b.closed,     onToggle: () => setGrpShow(s => ({ ...s, closed:     !s.closed     })) },
    { key: "inProgress", label: "In Progress", color: C.warn,   active: grpShow.inProgress, valFn: (b: typeof tp[0]) => b.opened - b.closed > 0 ? b.opened - b.closed : 0, onToggle: () => setGrpShow(s => ({ ...s, inProgress: !s.inProgress })) },
  ];

  const segSeries = [
    { key: "segOpened", label: "Segs Opened", color: C.purple,  active: segShow.segOpened, valFn: (b: typeof tpWithSegs[0]) => b.segOpened, onToggle: () => setSegShow(s => ({ ...s, segOpened: !s.segOpened })) },
    { key: "segClosed", label: "Segs Closed", color: "#8B5CF6", active: segShow.segClosed, valFn: (b: typeof tpWithSegs[0]) => b.segClosed, onToggle: () => setSegShow(s => ({ ...s, segClosed: !s.segClosed })) },
  ];

  const pieColors = [C.info, C.accent, C.warn, C.purple, "#C2410C", "#0891B2", "#7C3AED", "#BE185D"];
  const filteredByPolicy = policyFilter.length === 0
    ? stats.byPolicy
    : stats.byPolicy.filter(p => policyFilter.includes(p.policyId));
  const groupPieData = filteredByPolicy.map((p, i) => ({ label: p.policyName.replace("EXAMPLE - ", ""), value: p.total,         color: pieColors[i % pieColors.length] }));
  const segPieData   = filteredByPolicy.map((p, i) => ({ label: p.policyName.replace("EXAMPLE - ", ""), value: p.totalSegments, color: pieColors[i % pieColors.length] }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {renderChart("Event Group Throughput — Over Time", tp,         grpSeries as any, grpPinned, setGrpPinned, grpHovered, setGrpHovered)}
      {renderChart("Segment Throughput — Over Time",     tpWithSegs, segSeries as any, segPinned, setSegPinned, segHovered, setSegHovered)}

      {/* ── Pie charts ── */}
      {stats.byPolicy.length > 0 && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "20px 24px" }}>
          <div style={{ display: "flex", gap: 16 }}>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textMid, textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 10 }}>Event Groups per Policy</div>
              <PieSlices data={groupPieData} hovered={pieHovered} setHovered={setPieHovered} />
            </div>
            <div style={{ width: 1, background: C.border, alignSelf: "stretch" }} />
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textMid, textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 10 }}>Segments per Policy</div>
              <PieSlices data={segPieData} hovered={pieHovered} setHovered={setPieHovered} />
            </div>
          </div>
          <div style={{ marginTop: 16, borderTop: `1px solid ${C.border}`, paddingTop: 12, maxHeight: 88, overflowY: "auto" }}>
            <div style={{ display: "flex", flexWrap: "wrap" as const, gap: "6px 18px", justifyContent: "center" }}>
              {groupPieData.map((d, i) => (
                <div key={d.label} onMouseEnter={() => setPieHovered(i)} onMouseLeave={() => setPieHovered(null)}
                  style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", opacity: pieHovered !== null && pieHovered !== i ? 0.32 : 1, transition: "opacity 0.15s" }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: d.color, display: "inline-block", flexShrink: 0 }} />
                  <span style={{ fontSize: 11, color: pieHovered === i ? d.color : C.textMid, fontWeight: pieHovered === i ? 700 : 400, whiteSpace: "nowrap" as const }}>{d.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Heatmap ── */}
      <HeatmapChart tp={tp} />

      {/* Policy breakdown */}
      <div>
        <div style={{ fontSize: 12, fontWeight: 800, color: C.textMid, textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 10 }}>Policy breakdown</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10 }}>
          {stats.byPolicy.map(pol => {
            const color = polColors[pol.policyId] ?? C.accent;
            const rate = pol.total ? Math.round((pol.completed / pol.total) * 100) : 0;
            return (
              <div key={pol.policyId} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 14px" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.text, marginBottom: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{pol.policyName.replace("EXAMPLE - ", "")}</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
                  <div><div style={{ fontSize: 18, fontWeight: 800, fontFamily: "monospace", color }}>{pol.total}</div><div style={{ fontSize: 9, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.07em" }}>groups</div></div>
                  <div style={{ textAlign: "right" as const }}><div style={{ fontSize: 13, fontWeight: 700, fontFamily: "monospace", color: rate === 100 ? C.accent : C.textMid }}>{rate}%</div><div style={{ fontSize: 9, color: C.textMuted }}>complete</div></div>
                </div>
                <div style={{ marginTop: 8, height: 3, background: C.border, borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ width: `${rate}%`, height: "100%", background: color, borderRadius: 2, opacity: 0.7 }} />
                </div>
                {pol.inProgress > 0 && <div style={{ marginTop: 6, fontSize: 9, color: C.warn }}>{pol.inProgress} in progress</div>}
                {pol.avgDurationMs > 0 && <div style={{ marginTop: pol.inProgress > 0 ? 2 : 6, fontSize: 9, color: C.textMuted }}>avg {fmtMs(pol.avgDurationMs)}</div>}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── KPI summary row ── */}
      {(() => {
        const completionRate = stats.totalGroups > 0 ? Math.round((stats.completed / stats.totalGroups) * 100) : 0;
        const avgSegs = stats.totalGroups > 0 ? (stats.totalSegments / stats.totalGroups).toFixed(1) : "0";
        const throughput = tp.length > 0 ? Math.round(tp.slice(-6).reduce((a, b) => a + b.opened, 0) / 6) : 0;
        const stale = stats.inProgress;
        return (
          <div>
            <div style={{ fontSize: 12, fontWeight: 800, color: C.textMid, textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 10 }}>Key metrics</div>
            <div style={{ display: "flex", gap: 1 }}>
              {([
                { label: "Completion Rate",  value: completionRate + "%", sub: "groups closed",      color: C.accent },
                { label: "Avg Segs / Group", value: avgSegs,              sub: "across all policies",color: C.info   },
                { label: "Throughput",       value: throughput + "/hr",   sub: "groups opened",      color: C.purple },
                { label: "In Progress",      value: String(stats.inProgress), sub: "currently open", color: stats.inProgress > 0 ? C.warn : C.textMid },
              ] as { label: string; value: string; sub: string; color: string }[]).map(k => (
                <div key={k.label} style={{ flex: 1, background: C.surface, border: `1px solid ${C.border}`, padding: "12px 16px" }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: k.color, fontFamily: "monospace", lineHeight: 1 }}>{k.value}</div>
                  <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.07em", marginTop: 3 }}>{k.label}</div>
                  <div style={{ fontSize: 9, color: k.color, marginTop: 2, opacity: 0.7 }}>{k.sub}</div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ─── Reports — Policy Stats ───────────────────────────────────────────────────
function ReportsPolicyStats({ policies, stats }: { policies: Policy[]; stats: EventStats | null }) {
  if (!stats) return <div style={{ padding: 48, textAlign: "center", color: C.textMuted }}>Loading…</div>;
  const palette = [C.info, C.accent, C.warn, C.purple];
  const polColors: Record<string, string> = {};
  policies.forEach((p, i) => { polColors[p.id] = palette[i % palette.length]; });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: C.textMid, textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 4 }}>Per-policy metrics</div>
      {stats.byPolicy.map((pol, idx) => {
        const color      = polColors[pol.policyId] ?? palette[idx % palette.length];
        const timedOutPct = pol.total ? Math.round(((pol.timedOut ?? 0) / pol.total) * 100) : 0;
        const rate    = pol.total ? Math.round((pol.completed / pol.total) * 100) : 0;
        const isOpen  = expandedId === pol.policyId;
        const health  = rate >= 95 ? "healthy" : rate >= 80 ? "warning" : "critical";
        const hColor  = health === "healthy" ? C.accent : health === "warning" ? C.warn : C.danger;
        const hBg     = health === "healthy" ? C.accentLight : health === "warning" ? C.warnLight : C.dangerLight;
        const hLabel  = health === "healthy" ? "● Healthy" : health === "warning" ? "⚠ Warning" : "✕ Critical";
        return (
          <div key={pol.policyId} style={{ background: C.surface, border: `1px solid ${color}30`, borderRadius: 10, overflow: "hidden" }}>
            <div style={{ display: "flex", borderLeft: `4px solid ${color}`, padding: "14px 16px", gap: 16, alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" as const }}>
                  <span style={{ fontSize: 13, fontWeight: 800, color: C.text }}>{pol.policyName.replace("EXAMPLE - ", "")}</span>
                  <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: hBg, color: hColor, border: `1px solid ${hColor}30` }}>{hLabel}</span>
                  {(pol.timedOut ?? 0) > 0 && <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: C.timeoutLight, color: C.timeout, border: `1px solid ${C.timeoutSoft}` }}>⏱ {timedOutPct}% timed out</span>}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 10, marginBottom: 10 }}>
                  {([
                    { label: "Total",        value: pol.total.toLocaleString(),              color: C.text    },
                    { label: "Completed",    value: pol.completed.toLocaleString(),           color: C.accent  },
                    { label: "Timed Out",    value: (pol.timedOut ?? 0).toLocaleString(),     color: (pol.timedOut ?? 0) > 0 ? C.timeout : C.textMuted },
                    { label: "In Progress",  value: pol.inProgress.toLocaleString(),          color: pol.inProgress > 0 ? C.warn : C.textMuted },
                    { label: "Segments",     value: pol.totalSegments.toLocaleString(),       color: C.info    },
                    { label: "Avg Duration", value: pol.avgDurationMs ? fmtMs(pol.avgDurationMs) : "—", color: C.purple },
                  ] as { label: string; value: string; color: string }[]).map(s => (
                    <div key={s.label}>
                      <div style={{ fontSize: 15, fontWeight: 800, fontFamily: "monospace", color: s.color, lineHeight: 1 }}>{s.value}</div>
                      <div style={{ fontSize: 9, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.06em", marginTop: 2 }}>{s.label}</div>
                    </div>
                  ))}
                </div>
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                    <span style={{ fontSize: 10, color: C.textMuted }}>Completion rate</span>
                    <span style={{ fontSize: 10, fontFamily: "monospace", fontWeight: 700, color: hColor }}>{rate}%{(pol.timedOut ?? 0) > 0 ? ` · ${timedOutPct}% timed out` : ""}</span>
                  </div>
                  {/* Stacked bar: green = completed, orange = timed out */}
                  <div style={{ height: 5, background: C.border, borderRadius: 3, overflow: "hidden", display: "flex" }}>
                    <div style={{ width: `${rate}%`, height: "100%", background: `linear-gradient(90deg,${color},${color}cc)` }} />
                    <div style={{ width: `${timedOutPct}%`, height: "100%", background: C.timeout, opacity: 0.8 }} />
                  </div>
                  {(pol.timedOut ?? 0) > 0 && (
                    <div style={{ display: "flex", gap: 12, marginTop: 4, fontSize: 9, color: C.textMuted }}>
                      <span style={{ color }}>■ {rate}% completed</span>
                      <span style={{ color: C.timeout }}>■ {timedOutPct}% timed out</span>
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, flexShrink: 0 }}>
                <button onClick={() => setExpandedId(isOpen ? null : pol.policyId)}
                  style={{ padding: "4px 10px", border: `1px solid ${isOpen ? color : C.border}`, borderRadius: 5, background: isOpen ? color + "14" : "none", cursor: "pointer", fontSize: 10, color: isOpen ? color : C.textMid, fontFamily: "inherit" }}>
                  {isOpen ? "▲ Less" : "▼ Duration details"}
                </button>
              </div>
            </div>
            {isOpen && (
              <div style={{ padding: "12px 20px", borderTop: `1px solid ${C.border}`, background: C.surfaceAlt, display: "flex", gap: 24, alignItems: "flex-start" }}>
                <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.07em", paddingTop: 4 }}>Duration</div>
                {([
                  { label: "avg", value: pol.avgDurationMs, color: C.purple },
                  { label: "p50 (est)", value: Math.round(pol.avgDurationMs * 0.75), color: C.info },
                  { label: "p95 (est)", value: Math.round(pol.avgDurationMs * 2.2),  color: C.warn },
                ] as { label: string; value: number; color: string }[]).map(s => (
                  <div key={s.label}>
                    <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "monospace", color: s.color }}>{fmtMs(s.value)}</div>
                    <div style={{ fontSize: 9, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>{s.label}</div>
                  </div>
                ))}
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 9, color: C.textMuted, marginBottom: 6 }}>Relative scale</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {([
                      ["avg", pol.avgDurationMs, C.purple],
                      ["p50", Math.round(pol.avgDurationMs * 0.75), C.info],
                      ["p95", Math.round(pol.avgDurationMs * 2.2),  C.warn],
                    ] as [string, number, string][]).map(([l, v, c]) => {
                      const p95 = Math.round(pol.avgDurationMs * 2.2);
                      return (
                        <div key={l} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <span style={{ fontSize: 9, color: C.textMuted, width: 28 }}>{l}</span>
                          <div style={{ flex: 1, height: 4, background: C.border, borderRadius: 2, overflow: "hidden" }}>
                            <div style={{ width: `${Math.min((v / p95) * 100, 100)}%`, height: "100%", background: c, opacity: 0.75 }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {stats.byPolicy.length === 0 && <div style={{ padding: 32, textAlign: "center", color: C.textMuted, fontSize: 13 }}>No data in current filter window.</div>}
    </div>
  );
}

// ─── Reports — Event Group Performance ───────────────────────────────────────
function ReportsGroupExplorer({ policies, policyFilter, keyFilter, fromFilter, toFilter }: {
  policies: Policy[];
  policyFilter: string[];
  keyFilter: string;
  fromFilter: string;
  toFilter: string;
}) {
  const [cPerPage,   setCPerPage]   = useState(10);
  const [ipPerPage,  setIpPerPage]  = useState(10);
  const [cPage,      setCPage]      = useState(1);
  const [ipPage,     setIpPage]     = useState(1);
  const [openDetail, setOpenDetail] = useState<string | null>(null);
  const [detailData, setDetailData] = useState<Record<string, EventGroupDetail>>({});
  const [loadingId,  setLoadingId]  = useState<string | null>(null);
  const [perfData,   setPerfData]   = useState<import("./api").EventPerformance | null>(null);
  const [perfLoading,setPerfLoading]= useState(false);

  const palette = [C.info, C.accent, C.warn, C.purple];
  const polColors: Record<string, string> = {};
  policies.forEach((p, i) => { polColors[p.id] = palette[i % palette.length]; });
  const polMap = Object.fromEntries(policies.map(p => [p.id, p]));

  // Fetch performance data whenever filters change
  useEffect(() => {
    setPerfLoading(true);
    setOpenDetail(null);
    const from = fromFilter || undefined;
    const to   = toFilter   || undefined;
    const policyId = policyFilter.length === 1 ? policyFilter[0] : undefined;
    const aggregationKey = keyFilter || undefined;
    api.events.performance({ policyId, aggregationKey, from, to })
      .then(d => setPerfData(d))
      .catch(e => console.error("Performance fetch failed", e))
      .finally(() => setPerfLoading(false));
  }, [policyFilter, keyFilter, fromFilter, toFilter]);

  const completed  = perfData?.slowestCompleted  ?? [];
  const inProgress = perfData?.inProgressAging   ?? [];
  const histogram  = perfData?.durationHistogram ?? [];

  const filteredC  = completed;
  const filteredIP = inProgress;

  const cPages  = Math.ceil(filteredC.length  / cPerPage);
  const ipPages = Math.ceil(filteredIP.length / ipPerPage);
  const visC    = filteredC.slice((cPage-1)  * cPerPage,  cPage  * cPerPage);
  const visIP   = filteredIP.slice((ipPage-1) * ipPerPage, ipPage * ipPerPage);

  if (perfLoading) return <div style={{ padding: 48, textAlign: "center", color: C.textMuted }}>Loading performance data…</div>;

  async function toggleDetail(id: string) {
    if (openDetail === id) { setOpenDetail(null); return; }
    setOpenDetail(id);
    if (!detailData[id]) {
      setLoadingId(id);
      try { const d = await api.events.get(id); setDetailData(prev => ({ ...prev, [id]: d })); }
      catch (e) { console.error(e); }
      finally { setLoadingId(null); }
    }
  }

  function RowsPerPageSelect({ value, onChange }: { value: number; onChange: (n: number) => void }) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 11, color: C.textMuted }}>Rows per page</span>
        <div style={{ position: "relative" }}>
          <select value={value} onChange={e => onChange(Number(e.target.value))}
            style={{ appearance: "none" as const, border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 22px 4px 8px", fontSize: 11, fontFamily: "inherit", fontWeight: 600, color: C.textMid, background: C.surfaceAlt, cursor: "pointer", outline: "none" }}>
            {[5, 10, 25, 50].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
          <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke={C.textMuted} strokeWidth="2" style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}><path d="M4 6l4 4 4-4"/></svg>
        </div>
      </div>
    );
  }

  function PageControls({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (p: number) => void }) {
    if (totalPages <= 1) return null;
    const pages: (number | "…")[] = [];
    if (page > 2) pages.push(1); if (page > 3) pages.push("…");
    [page-1, page, page+1].filter(p => p >= 1 && p <= totalPages).forEach(p => pages.push(p));
    if (page < totalPages - 2) pages.push("…"); if (page < totalPages - 1) pages.push(totalPages);
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 6, padding: "10px 0" }}>
        <button onClick={() => onChange(Math.max(1, page-1))} disabled={page===1} style={{ padding: "4px 10px", border: `1px solid ${C.border}`, borderRadius: 5, background: C.surface, cursor: page===1?"default":"pointer", fontSize: 11, fontFamily: "inherit", color: page===1?C.textMuted:C.text, opacity: page===1?0.45:1 }}>← Prev</button>
        {pages.map((p, i) => p === "…" ? <span key={"e"+i} style={{ fontSize: 11, color: C.textMuted }}>…</span> :
          <button key={p} onClick={() => onChange(p as number)} style={{ padding: "4px 10px", border: `1px solid ${p===page?C.accent:C.border}`, borderRadius: 5, background: p===page?C.accentLight:C.surface, cursor: "pointer", fontSize: 11, fontWeight: p===page?700:400, color: p===page?C.accent:C.text, fontFamily: "inherit", minWidth: 32 }}>{p}</button>
        )}
        <button onClick={() => onChange(Math.min(totalPages, page+1))} disabled={page===totalPages} style={{ padding: "4px 10px", border: `1px solid ${C.border}`, borderRadius: 5, background: C.surface, cursor: page===totalPages?"default":"pointer", fontSize: 11, fontFamily: "inherit", color: page===totalPages?C.textMuted:C.text, opacity: page===totalPages?0.45:1 }}>Next →</button>
        <span style={{ fontSize: 11, color: C.textMuted, marginLeft: 4 }}>Page {page} of {totalPages}</span>
      </div>
    );
  }

  function InlineDetail({ groupId, summary }: { groupId: string; summary: EventGroupSummary }) {
    const detail    = detailData[groupId];
    const isLoading = loadingId === groupId;
    const pol       = polMap[summary.policyId];
    const [openSeg, setOpenSeg] = useState<number | null>(null);
    if (isLoading) return <div style={{ padding: "16px 0", textAlign: "center", color: C.textMuted, fontSize: 12 }}>Loading…</div>;
    if (!detail) return null;
    const endTs   = detail.endTime ? new Date(detail.endTime).getTime() : Date.now();
    const startTs = new Date(detail.startTime).getTime();
    const totalMs = endTs - startTs;
    const segs    = detail.segments;
    return (
      <div style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 8, padding: "14px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: C.textMuted, fontFamily: "monospace", marginBottom: 2 }}>GROUP DETAIL</div>
            <div style={{ fontSize: 13, fontWeight: 800, fontFamily: "monospace", color: C.accent }}>{summary.aggregationKey}</div>
            <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
              <span style={{ background: (polColors[summary.policyId] ?? C.accent) + "18", color: polColors[summary.policyId] ?? C.accent, padding: "2px 7px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>{summary.policyName.replace("EXAMPLE - ", "")}</span>
              <span style={{ background: summary.status === "completed" ? C.accentLight : C.warnLight, color: summary.status === "completed" ? C.accent : C.warn, padding: "2px 7px", borderRadius: 4, fontSize: 10, fontWeight: 700, fontFamily: "monospace" }}>{summary.status === "completed" ? "● Completed" : "◐ In Progress"}</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <div style={{ textAlign: "right" as const }}><div style={{ fontSize: 16, fontWeight: 800, fontFamily: "monospace" }}>{fmtMs(totalMs)}</div><div style={{ fontSize: 9, color: C.textMuted }}>{fmt(detail.startTime)} → {detail.endTime ? fmt(detail.endTime) : "ongoing"}</div></div>
            <button onClick={() => setOpenDetail(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: C.textMuted, lineHeight: 1 }}>×</button>
          </div>
        </div>
        {segs.length === 0 ? <div style={{ padding: "16px 0", textAlign: "center", color: C.textMuted, fontSize: 12 }}>No segments loaded.</div> : (
          <>
            <div style={{ position: "relative", height: 8, background: C.border, borderRadius: 4, margin: "28px 0 52px" }}>
              <div style={{ position: "absolute", inset: 0, background: `linear-gradient(90deg, ${C.accentSoft}, ${C.accent})`, borderRadius: 4, opacity: 0.25 }} />
              {segs.map((seg, i) => {
                const pct  = totalMs > 0 ? ((new Date(seg.timestamp).getTime() - startTs) / totalMs) * 100 : i * (100 / Math.max(segs.length-1, 1));
                const safe = Math.min(Math.max(pct, 0), 96);
                const isCradle = pol ? String(resolvePath(seg.body, pol.cradleField)) === pol.cradleValue : false;
                const isGrave  = pol ? String(resolvePath(seg.body, pol.graveField))  === pol.graveValue  : false;
                const c = isCradle ? C.accent : isGrave ? C.danger : C.info;
                const isOpen = openSeg === i;
                return (
                  <div key={seg.eventId} onClick={() => setOpenSeg(isOpen ? null : i)} style={{ position: "absolute", left: safe + "%", top: "50%", transform: "translate(-50%,-50%)", cursor: "pointer", zIndex: 2 }}>
                    <div style={{ position: "absolute", left: "50%", top: 8, width: 1, height: 28, background: c, opacity: 0.4 }} />
                    <div style={{ width: 16, height: 16, borderRadius: "50%", background: isOpen ? c : C.surface, border: `2px solid ${c}`, transition: "background 0.15s", boxShadow: isOpen ? `0 0 0 3px ${c}25` : "none" }} />
                    <div style={{ position: "absolute", top: 38, left: "50%", transform: "translateX(-50%)", whiteSpace: "nowrap" as const, fontSize: 9, fontFamily: "monospace", color: c, fontWeight: 700, textAlign: "center" as const }}>
                      {seg.sequence}. {String((seg.body as Record<string, unknown>).eventType ?? "").split(".").pop()}
                      {isCradle && <div style={{ fontSize: 8, color: C.accent }}>▶ cradle</div>}
                      {isGrave  && <div style={{ fontSize: 8, color: C.danger }}>■ grave</div>}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ position: "relative", height: 16, margin: "4px 0 0" }}>
              {segs.slice(0, -1).map((seg, i) => {
                const next = segs[i+1];
                const sp = totalMs > 0 ? ((new Date(seg.timestamp).getTime() - startTs) / totalMs) * 100 : i * (100 / Math.max(segs.length-1, 1));
                const ep = totalMs > 0 ? ((new Date(next.timestamp).getTime() - startTs) / totalMs) * 100 : (i+1) * (100 / Math.max(segs.length-1, 1));
                const gapMs = new Date(next.timestamp).getTime() - new Date(seg.timestamp).getTime();
                return (
                  <div key={i} style={{ position: "absolute", left: ((sp+ep)/2) + "%", transform: "translateX(-50%)", whiteSpace: "nowrap" as const }}>
                    <span style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "1px 5px", fontSize: 8, color: C.textMuted }}>{fmtMs(gapMs)}</span>
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 14, paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
              <span style={{ fontSize: 9, color: C.textMuted, fontFamily: "monospace" }}>{fmt(detail.startTime)}</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: C.purple, fontFamily: "monospace" }}>{fmtMs(totalMs)} total</span>
              <span style={{ fontSize: 9, color: C.textMuted, fontFamily: "monospace" }}>{detail.endTime ? fmt(detail.endTime) : "ongoing"}</span>
            </div>
            {openSeg !== null && segs[openSeg] && (
              <div style={{ marginTop: 10, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: "10px 12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 11, fontWeight: 700 }}>Segment {segs[openSeg].sequence}</span>
                  <span style={{ fontSize: 10, color: C.textMuted, fontFamily: "monospace" }}>{fmt(segs[openSeg].timestamp)}</span>
                </div>
                <pre style={{ margin: 0, fontSize: 11, fontFamily: "monospace", color: C.text, background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 4, padding: "8px 10px", overflowX: "auto", maxHeight: 120, overflowY: "auto" }}>
                  {JSON.stringify(segs[openSeg].body, null, 2)}
                </pre>
              </div>
            )}
            {openSeg === null && <div style={{ marginTop: 8, fontSize: 9, color: C.textMuted, textAlign: "center" as const }}>Click a dot to inspect segment body</div>}
          </>
        )}
      </div>
    );
  }

  function GroupRow({ g, isCompleted, idx, total }: { g: EventGroupSummary; isCompleted: boolean; idx: number; total: number }) {
    const ageMs  = Date.now() - new Date(g.startTime).getTime();
    const warn   = !isCompleted && ageMs > 3600000;
    const color  = polColors[g.policyId] ?? C.accent;
    const isOpen = openDetail === g.id;
    return (
      <>
        <tr style={{ borderBottom: !isOpen && idx < total-1 ? `1px solid ${C.border}` : "none", background: isOpen ? C.accentLight + "30" : warn ? C.warnLight + "50" : "none", cursor: "default", transition: "background 0.1s" }}
          onMouseEnter={e => { if (!isOpen) e.currentTarget.style.background = C.surfaceAlt; }}
          onMouseLeave={e => { e.currentTarget.style.background = isOpen ? C.accentLight + "30" : warn ? C.warnLight + "50" : "none"; }}>
          <td style={{ padding: "9px 12px" }}><div style={{ display: "flex", alignItems: "center", gap: 6 }}>{warn && <span title="Open longer than 1h" style={{ color: C.warn }}>⚠</span>}<code style={{ fontSize: 11, fontFamily: "monospace", color: C.accent }}>{g.id.slice(0, 16)}…</code></div></td>
          <td style={{ padding: "9px 12px" }}><span style={{ background: color + "18", color, padding: "2px 6px", borderRadius: 3, fontSize: 10, fontWeight: 700 }}>{g.policyName.replace("EXAMPLE - ", "")}</span></td>
          <td style={{ padding: "9px 12px" }}><span style={{ fontFamily: "monospace", fontSize: 11, color: C.textMid }}>{g.aggregationKey}</span></td>
          {isCompleted
            ? <>
              <td style={{ padding: "9px 12px" }}><span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 700, color: (g.durationMs??0)>86400000?C.danger:(g.durationMs??0)>3600000?C.warn:C.textMid }}>{fmtMs(g.durationMs??0)}</span></td>
              <td style={{ padding: "9px 12px", textAlign: "center" as const }}><span style={{ fontSize: 11 }}>{g.segmentCount}</span></td>
              <td style={{ padding: "9px 12px" }}><span style={{ fontSize: 11, color: C.textMuted }}>{g.endTime ? timeAgo(g.endTime) : "—"}</span></td>
            </>
            : <>
              <td style={{ padding: "9px 12px" }}><span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 700, color: warn ? C.warn : C.textMid }}>{fmtMs(ageMs)}</span></td>
              <td style={{ padding: "9px 12px", textAlign: "center" as const }}><span style={{ fontSize: 11 }}>{g.segmentCount}</span></td>
              <td style={{ padding: "9px 12px" }}><span style={{ fontSize: 11, color: C.textMuted }}>{timeAgo(g.startTime)}</span></td>
            </>
          }
          <td style={{ padding: "9px 12px" }}>
            <button onClick={() => toggleDetail(g.id)} style={{ padding: "3px 8px", border: `1px solid ${isOpen ? C.accent : C.border}`, borderRadius: 4, background: isOpen ? C.accentLight : "none", cursor: "pointer", fontSize: 10, color: isOpen ? C.accent : C.textMid, fontFamily: "inherit" }}>
              {loadingId === g.id ? "Loading…" : isOpen ? "▲ Close" : "Timeline →"}
            </button>
          </td>
        </tr>
        {isOpen && <tr><td colSpan={7} style={{ padding: "0 12px 12px" }}><InlineDetail groupId={g.id} summary={g} /></td></tr>}
      </>
    );
  }

  // Duration distribution from dedicated API query
  const bucketCounts = histogram;
  const maxBucket = Math.max(...bucketCounts.map(b => b.count), 1);

  // Summary stats
  const allGroups = [...completed, ...inProgress];
  const slowest   = completed[0];
  const fastest   = completed.length > 0 ? completed[completed.length - 1] : null;
  const mostSegs  = [...allGroups].sort((a, b) => b.segmentCount - a.segmentCount)[0];
  const staleCount = inProgress.filter(e => Date.now() - new Date(e.startTime).getTime() > 86400000).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>

      {/* ── Summary stats bar ── */}
      {allGroups.length > 0 && (
        <div style={{ display: "flex", gap: 1 }}>
          {([
            { label: "Slowest Group",     value: slowest  ? fmtMs(slowest.durationMs ?? 0)  : "—", sub: slowest?.aggregationKey  ?? "", color: C.danger },
            { label: "Fastest Completed", value: fastest  ? fmtMs(fastest.durationMs ?? 0)  : "—", sub: fastest?.aggregationKey  ?? "", color: C.accent },
            { label: "Most Segments",     value: mostSegs ? String(mostSegs.segmentCount)    : "—", sub: mostSegs?.aggregationKey ?? "", color: C.info   },
            { label: "Stale Open",        value: String(staleCount),                               sub: "open > 24h",                   color: staleCount > 0 ? C.warn : C.textMid },
          ] as { label: string; value: string; sub: string; color: string }[]).map(s => (
            <div key={s.label} style={{ flex: 1, background: C.surface, border: `1px solid ${C.border}`, padding: "10px 14px" }}>
              <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "monospace", color: s.color, lineHeight: 1 }}>{s.value}</div>
              <div style={{ fontSize: 9, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.07em", marginTop: 3 }}>{s.label}</div>
              <div style={{ fontSize: 9, color: s.color, opacity: 0.7, marginTop: 1, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{s.sub}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Slowest completed groups ── */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
        <div style={{ padding: "10px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" as const, gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: C.textMid, textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>Slowest completed groups</div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" as const }}>
            <RowsPerPageSelect value={cPerPage} onChange={n => { setCPerPage(n); setCPage(1); setOpenDetail(null); }} />
          </div>
        </div>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr style={{ background: C.surfaceAlt }}>
            {["Event Group ID", "Policy", "Key", "Duration", "Segs", "Completed", ""].map(h => (
              <th key={h} style={{ padding: "6px 12px", textAlign: "left", fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.07em", borderBottom: `1px solid ${C.border}` }}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {filteredC.length === 0 && <tr><td colSpan={7} style={{ padding: 24, textAlign: "center", color: C.textMuted, fontSize: 13 }}>No completed groups in current filter.</td></tr>}
            {visC.map((g, i) => <GroupRow key={g.id} g={g} isCompleted={true} idx={i} total={visC.length} />)}
          </tbody>
        </table>
        <div style={{ padding: "0 16px" }}><PageControls page={cPage} totalPages={cPages} onChange={setCPage} /></div>
      </div>

      {/* ── In-progress aging ── */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
        <div style={{ padding: "10px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" as const, gap: 8 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 800, color: C.textMid, textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>In-progress aging</div>
            <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>Sorted oldest first · ⚠ open longer than 1h</div>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" as const }}>
            <RowsPerPageSelect value={ipPerPage} onChange={n => { setIpPerPage(n); setIpPage(1); setOpenDetail(null); }} />
          </div>
        </div>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr style={{ background: C.surfaceAlt }}>
            {["Event Group ID", "Policy", "Key", "Age", "Segs", "Started", ""].map(h => (
              <th key={h} style={{ padding: "6px 12px", textAlign: "left", fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.07em", borderBottom: `1px solid ${C.border}` }}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {filteredIP.length === 0 && <tr><td colSpan={7} style={{ padding: 24, textAlign: "center", color: C.textMuted, fontSize: 13 }}>No in-progress groups.</td></tr>}
            {visIP.map((g, i) => <GroupRow key={g.id} g={g} isCompleted={false} idx={i} total={visIP.length} />)}
          </tbody>
        </table>
        <div style={{ padding: "0 16px" }}><PageControls page={ipPage} totalPages={ipPages} onChange={setIpPage} /></div>
      </div>

      {/* ── Duration distribution histogram ── */}
      {completed.length > 0 && histogram.length > 0 && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: C.textMid, textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 4 }}>Duration Distribution — Completed Groups</div>
          <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 14, fontFamily: "monospace" }}>How long do completed groups take?</div>
          <div style={{ display: "flex", gap: 4, alignItems: "flex-end", height: 90 }}>
            {bucketCounts.map((b, idx) => {
              const h = Math.max((b.count / maxBucket) * 80, b.count ? 3 : 0);
              const color = idx <= 1 ? C.accent : idx <= 3 ? C.info : idx <= 4 ? C.purple : idx <= 6 ? C.warn : C.danger;
              return (
                <div key={b.bucket} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                  <span style={{ fontSize: 9, fontFamily: "monospace", color: b.count > 0 ? color : "transparent", fontWeight: 700 }}>{b.count}</span>
                  <div style={{ width: "100%", height: h, background: color, borderRadius: "3px 3px 0 0", opacity: 0.78 }} title={`${b.bucket}: ${b.count} groups`} />
                  <span style={{ fontSize: 8, color: C.textMuted, fontFamily: "monospace", textAlign: "center" as const, lineHeight: 1.2, whiteSpace: "nowrap" as const }}>{b.bucket}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Flat segment type for the segments tab ───────────────────────────────────
interface FlatSegment extends SegmentDetail {
  groupId: string;
  policyName: string;
  aggregationKey: string;
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [sessionUser, setSessionUser] = useState<import("./api").SessionUser | null | undefined>(undefined);
  const [appUsers,    setAppUsers]    = useState<import("./api").AppUser[]>([]);

  React.useEffect(() => {
    api.auth.me().then(u => setSessionUser(u)).catch(() => setSessionUser(null));
  }, []);

  React.useEffect(() => {
    if (sessionUser?.role === "admin") {
      api.auth.users.list().then(setAppUsers).catch(() => {});
    }
  }, [sessionUser]);

  function loadAppUsers() {
    if (sessionUser?.role === "admin") {
      api.auth.users.list().then(setAppUsers).catch(() => {});
    }
  }

  async function handleLogin(username: string, password: string) {
    const u = await api.auth.login(username, password);
    setSessionUser(u);
  }
  async function handleLogout() {
    await api.auth.logout().catch(() => {});
    setSessionUser(null);
  }

  if (sessionUser === undefined) {
    return (
      <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ fontSize: 14, color: C.textMuted, fontFamily: "Calibri, sans-serif" }}>Loading…</div>
      </div>
    );
  }
  if (sessionUser === null) {
    return <LoginScreen onLogin={handleLogin} />;
  }
  if (sessionUser.passwordChanged === false) {
    return <ChangePasswordScreen user={sessionUser} onChanged={async () => {
      // Re-fetch session to get updated passwordChanged flag
      const u = await api.auth.me().catch(() => null);
      if (u) setSessionUser({ ...u, passwordChanged: true });
    }} />;
  }
  return (
    <MainApp
      sessionUser={sessionUser}
      appUsers={appUsers}
      onLogout={handleLogout}
      onUsersChanged={loadAppUsers}
    />
  );
}

function MainApp({ sessionUser, appUsers, onLogout, onUsersChanged }: {
  sessionUser: import("./api").SessionUser;
  appUsers: import("./api").AppUser[];
  onLogout: () => void;
  onUsersChanged: () => void;
}) {
  const [policies,       setPolicies]    = useState<Policy[]>([]);
  const [events,         setEvents]      = useState<EventGroupSummary[]>([]);
  const [eventsTotal,    setEventsTotal] = useState(0);
  const [eventStats,     setEventStats]  = useState<EventStats | null>(null);
  const [totalPages,     setTotalPages]  = useState(1);
  const [loading,        setLoading]     = useState(true);
  const [loadError,      setLoadError]   = useState<string | null>(null);
  const [selected,       setSelected]    = useState<EventGroupDetail | null>(null);
  const [focusSegmentId, setFocusSegmentId] = useState<string | undefined>(undefined);
  const [showPolicies,   setShowPolicies]  = useState(false);
  const [showIngest,     setShowIngest]    = useState(false);

  // Top-level view
  const [view,           setView]        = useState<"events" | "reports">("events");
  const [reportSection,  setReportSection] = useState<"overview" | "policies" | "explorer" | "audit">("overview");

  // Live highlighting — track which group IDs changed and why
  const [highlighted,    setHighlighted] = useState<HighlightedGroup[]>([]);
  const prevEventsRef    = useRef<EventGroupSummary[]>([]);

  // Tabs
  const [activeTab,      setActiveTab]   = useState<"groups" | "segments">("groups");

  // Flat segments (loaded when segments tab is active)
  const [segments,       setSegments]    = useState<FlatSegment[]>([]);
  const [segsLoading,    setSegsLoading] = useState(false);
  const [segPage,        setSegPage]     = useState(1);

  // Column visibility
  const [groupVisible, setGroupVisible] = useState<Set<string>>(new Set(GROUP_COLS.map(c => c.key)));
  const [segVisible,   setSegVisible]   = useState<Set<string>>(new Set(SEG_COLS.map(c => c.key)));
  const [showColMenu,  setShowColMenu]  = useState(false);
  const [showExport,       setShowExport]       = useState(false);
  const [exporting,        setExporting]        = useState<string | null>(null);
  const [showReportExport, setShowReportExport] = useState(false);
  const [reportExporting,  setReportExporting]  = useState<string | null>(null);

  // Column widths
  const [groupWidths, setGroupWidths] = useState<Record<string, number>>(Object.fromEntries(GROUP_COLS.map(c => [c.key, c.defaultWidth])));
  const [segWidths,   setSegWidths]   = useState<Record<string, number>>(Object.fromEntries(SEG_COLS.map(c => [c.key, c.defaultWidth])));

  // Filters
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [keyFilter,    setKeyFilter]    = useState("");
  const [policyFilter, setPolicyFilter] = useState<string[]>([]);
  const _now = new Date();
  const [fromFilter,   setFromFilter]   = useState("");
  const [toFilter,     setToFilter]     = useState("");
  const [page,         setPage]         = useState(1);
  const [autoRefresh,  setAutoRefresh]  = useState(false);
  const [dateRange,    setDateRange]    = useState("24h");
  const [bodySearch,   setBodySearch]   = useState("");
  const PAGE_SIZE_OPTIONS = [25, 50, 100];
  const [perPage,        setPerPage]     = useState(25);

  function handlePerPageChange(n: number) {
    setPerPage(n);
    setPage(1);
    setSegPage(1);
  }

  const PER_PAGE = perPage;

  // ── Date range ──────────────────────────────────────────────────────────────
  function applyDateRange(preset: string) {
    setDateRange(preset);
    const now = new Date();
    const startOf = (d: Date) => { const s = new Date(d); s.setHours(0, 0, 0, 0); return s.toISOString(); };
    const daysAgo   = (n: number) => { const d = new Date(now); d.setDate(d.getDate() - n);   return startOf(d); };
    const monthsAgo = (n: number) => { const d = new Date(now); d.setMonth(d.getMonth() - n); return startOf(d); };
    const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999);
    const toNow = todayEnd.toISOString();
    switch (preset) {
      case "24h":    setFromFilter(daysAgo(1));   setToFilter(toNow); break;
      case "7d":     setFromFilter(daysAgo(7));   setToFilter(toNow); break;
      case "30d":    setFromFilter(daysAgo(30));  setToFilter(toNow); break;
      case "6m":     setFromFilter(monthsAgo(6)); setToFilter(toNow); break;
      case "custom": break;
      default:       setFromFilter(""); setToFilter(""); break;
    }
    setPage(1);
  }

  // ── Load policies ────────────────────────────────────────────────────────────
  const loadPolicies = useCallback(async () => {
    try { setPolicies(await api.policies.list()); }
    catch (e: any) { console.error("Failed to load policies:", e); }
  }, []);

  // ── Load events ──────────────────────────────────────────────────────────────
  const loadEventStats = useCallback(async () => {
    try {
      const from = fromFilter || undefined;
      const to   = toFilter   || undefined;
      const stats = await api.events.stats({ status: statusFilter.length === 1 ? statusFilter[0] as "in_progress"|"completed"|"timed_out" : "all", policyId: policyFilter.length === 1 ? policyFilter[0] : undefined, aggregationKey: keyFilter || undefined, from, to });
      setEventStats(stats);
    } catch (e) { console.error("Failed to load event stats", e); }
  }, [statusFilter, policyFilter, keyFilter, fromFilter, toFilter]);

  const loadEvents = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const from = bodySearch.trim() ? undefined : (fromFilter || undefined);
      const to   = bodySearch.trim() ? undefined : (toFilter   || undefined);
      const res = await api.events.list({ status: statusFilter.length === 1 ? statusFilter[0] as "in_progress"|"completed"|"timed_out" : "all", policyId: policyFilter.length === 1 ? policyFilter[0] : undefined, aggregationKey: keyFilter || undefined, from, to, bodySearch: bodySearch || undefined, page, limit: PER_PAGE });

      // ── Live highlighting: diff previous results against new ──────────────
      const prev = prevEventsRef.current;
      if (prev.length > 0) {
        const prevMap = new Map(prev.map(e => [e.id, e]));
        const newHighlights: HighlightedGroup[] = [];
        res.data.forEach(e => {
          const p = prevMap.get(e.id);
          if (!p) {
            newHighlights.push({ id: e.id, reason: "new" });
          } else if (p.status === "in_progress" && e.status === "completed") {
            newHighlights.push({ id: e.id, reason: "promoted" });
          } else if (p.segmentCount !== e.segmentCount) {
            newHighlights.push({ id: e.id, reason: "segment" });
          }
        });
        if (newHighlights.length > 0) {
          setHighlighted(newHighlights);
          setTimeout(() => setHighlighted([]), 3000);
        }
      }
      prevEventsRef.current = res.data;

      // Client-side filter when multiple statuses selected (API only takes one)
      const filtered = statusFilter.length > 1
        ? res.data.filter(e => statusFilter.includes(e.status))
        : res.data;
      setEvents(filtered); setEventsTotal(statusFilter.length > 1 ? filtered.length : res.total); setTotalPages(statusFilter.length > 1 ? 1 : res.totalPages);
    } catch (e: any) { setLoadError(e.message ?? "Failed to load events"); }
    finally { setLoading(false); }
  }, [statusFilter, policyFilter, keyFilter, fromFilter, toFilter, bodySearch, page]);

  // ── Load flat segments (for segments tab) ─────────────────────────────────
  const loadSegments = useCallback(async () => {
    if (events.length === 0) { setSegments([]); return; }
    setSegsLoading(true);
    try {
      const all: FlatSegment[] = [];
      await Promise.all(events.map(async ev => {
        try {
          const detail = await api.events.get(ev.id);
          detail.segments.forEach(seg => all.push({ ...seg, groupId: ev.id, policyName: ev.policyName, aggregationKey: ev.aggregationKey }));
        } catch { /* skip failed group */ }
      }));
      all.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setSegments(all);
      setSegPage(1);
    } catch (e: any) { console.error("Failed to load segments:", e); }
    finally { setSegsLoading(false); }
  }, [events]);

  useEffect(() => { loadPolicies(); }, [loadPolicies]);
  useEffect(() => { loadEvents(); loadEventStats(); }, [loadEvents, loadEventStats]);
  useEffect(() => { setPage(1); }, [statusFilter, policyFilter, keyFilter, fromFilter, toFilter]);
  // bodySearch gets its own effect so loadEvents always fires even when page is already 1
  useEffect(() => { loadEvents(); loadEventStats(); }, [bodySearch]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!autoRefresh) return; const id = setInterval(loadEvents, 10000); return () => clearInterval(id); }, [autoRefresh, loadEvents]);
  useEffect(() => { if (activeTab === "segments") loadSegments(); }, [activeTab, loadSegments]);

  // ── Detail / CRUD ─────────────────────────────────────────────────────────
  async function openDetail(id: string, segmentId?: string) {
    try { setFocusSegmentId(segmentId); setSelected(await api.events.get(id)); } catch (e: any) { console.error(e); }
  }
  async function savePolicy(form: PolicyForm) {
    const payload = { name: form.name, domain: form.domain, keyField: form.keyField, cradleField: form.cradleField, cradleValue: form.cradleValue, graveField: form.graveField, graveValue: form.graveValue, description: form.description || null, timeoutMs: form.timeoutMs ?? null };
    if (form.id) await api.policies.update(form.id, payload); else await api.policies.create(payload);
    await loadPolicies();
  }
  async function togglePolicy(id: string, active: boolean) {
    try { await api.policies.toggle(id, active); await loadPolicies(); } catch (e) { console.error(e); }
  }
  async function deletePolicy(id: string) { await api.policies.delete(id); await loadPolicies(); }
  async function handleIngest(input: { policyId: string; body: Record<string, unknown> }) {
    const result = await api.ingest.send(input); await loadEvents(); return result;
  }
  function clearFilters() { setStatusFilter([]); setPolicyFilter([]); setKeyFilter(""); setFromFilter(""); setToFilter(""); setDateRange("all"); setBodySearch(""); setPage(1); }

  function handleReportExport(format: "PDF" | "JSON") {
    setShowReportExport(false);
    setReportExporting(format);
    const section = reportSection;
    setTimeout(() => {
      const rangeLabels: Record<string, string> = { "24h": "Last 24h", "7d": "Last 7 days", "30d": "Last 30 days", "6m": "Last 6 months", "all": "All time" };

      if (format === "JSON") {
        let payload: unknown;
        if (section === "overview") {
          payload = { exportedAt: new Date().toISOString(), section: "overview", dateRange, summary: { totalGroups: eventStats?.totalGroups, completed: eventStats?.completed, inProgress: eventStats?.inProgress, totalSegments: eventStats?.totalSegments, avgDurationMs: eventStats?.avgDurationMs }, throughput: eventStats?.throughput, byPolicy: eventStats?.byPolicy };
        } else if (section === "policies") {
          payload = { exportedAt: new Date().toISOString(), section: "policy_stats", dateRange, byPolicy: eventStats?.byPolicy };
        } else {
          payload = { exportedAt: new Date().toISOString(), section: "group_explorer", dateRange, events: events.map(e => ({ id: e.id, policyName: e.policyName, aggregationKey: e.aggregationKey, status: e.status, segmentCount: e.segmentCount, startTime: e.startTime, endTime: e.endTime, durationMs: e.durationMs })) };
        }
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "eventagg-" + section + "-" + Date.now() + ".json"; a.click();

      } else {
        function buildSvgChart(title: string, data: { bucket: string; v1: number; v2: number; v3?: number }[], c1: string, l1: string, c2: string, l2: string, c3?: string, l3?: string): string {
          if (!data.length) return "<p style='color:#8A8680;font-size:12px'>No data</p>";
          const W = 800, H = 140, PAD = 8;
          const maxV = Math.max(...data.map(d => Math.max(d.v1, d.v2, d.v3 ?? 0)), 1);
          const bw = (W - PAD * 2) / data.length;
          const cols = c3 ? 3 : 2; const gap = 1;
          const barW = Math.max(1, (bw - gap * (cols - 1) - 2) / cols);
          const bars = data.map((d, i) => {
            const x = PAD + i * bw;
            const h1 = Math.max((d.v1 / maxV) * (H - 20), d.v1 ? 1 : 0);
            const h2 = Math.max((d.v2 / maxV) * (H - 20), d.v2 ? 1 : 0);
            const h3 = d.v3 !== undefined ? Math.max((d.v3 / maxV) * (H - 20), d.v3 ? 1 : 0) : 0;
            return "<rect x=\"" + x + "\" y=\"" + (H-20-h1) + "\" width=\"" + barW + "\" height=\"" + h1 + "\" fill=\"" + c1 + "\" opacity=\"0.85\"/>"
              + "<rect x=\"" + (x+barW+gap) + "\" y=\"" + (H-20-h2) + "\" width=\"" + barW + "\" height=\"" + h2 + "\" fill=\"" + c2 + "\" opacity=\"0.7\"/>"
              + (c3 ? "<rect x=\"" + (x+barW*2+gap*2) + "\" y=\"" + (H-20-h3) + "\" width=\"" + barW + "\" height=\"" + h3 + "\" fill=\"" + c3 + "\" opacity=\"0.75\"/>" : "");
          }).join("");
          const step = Math.max(1, Math.floor(data.length / 5));
          const labels = data.filter((_, i) => i % step === 0).map((d, idx) => {
            const x = PAD + idx * step * bw + bw / 2;
            const lbl = d.bucket.length > 10 ? d.bucket.slice(5) : d.bucket;
            return "<text x=\"" + x + "\" y=\"" + (H-4) + "\" text-anchor=\"middle\" font-size=\"7\" fill=\"#8A8680\" font-family=\"monospace\">" + lbl + "</text>";
          }).join("");
          const legend = "<text x=\"" + PAD + "\" y=\"10\" font-size=\"8\" fill=\"" + c1 + "\" font-family=\"sans-serif\">&#9632; " + l1 + "</text>"
            + "<text x=\"" + (PAD+80) + "\" y=\"10\" font-size=\"8\" fill=\"" + c2 + "\" font-family=\"sans-serif\">&#9632; " + l2 + "</text>"
            + (c3 && l3 ? "<text x=\"" + (PAD+160) + "\" y=\"10\" font-size=\"8\" fill=\"" + c3 + "\" font-family=\"sans-serif\">&#9632; " + l3 + "</text>" : "");
          return "<div style=\"margin-bottom:4px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.07em;color:#4A4844\">" + title + "</div>"
            + "<svg width=\"100%\" viewBox=\"0 0 " + W + " " + H + "\" xmlns=\"http://www.w3.org/2000/svg\">"
            + "<rect width=\"" + W + "\" height=\"" + H + "\" fill=\"#F8F7F4\" rx=\"4\"/>"
            + "<line x1=\"" + PAD + "\" y1=\"" + (H-20) + "\" x2=\"" + (W-PAD) + "\" y2=\"" + (H-20) + "\" stroke=\"#E0DDD8\" stroke-width=\"1\"/>"
            + legend + bars + labels + "</svg>";
        }

        const css = "body{font-family:Georgia,serif;max-width:900px;margin:40px auto;color:#1A1916}"
          + "h1{font-size:22px;margin-bottom:4px}h2{font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:0.08em;color:#4A4844;margin:24px 0 8px}"
          + ".meta{font-size:12px;color:#8A8680;margin-bottom:20px}.stats{display:flex;gap:10px;margin-bottom:20px}"
          + ".stat{flex:1;border:1px solid #E0DDD8;border-radius:6px;padding:10px}.stat .val{font-size:22px;font-weight:800;font-family:monospace}"
          + ".stat .lbl{font-size:9px;color:#8A8680;text-transform:uppercase;letter-spacing:0.08em;margin-top:2px}"
          + ".chart{background:#F8F7F4;border:1px solid #E0DDD8;border-radius:6px;padding:12px;margin-bottom:12px}"
          + "table{width:100%;border-collapse:collapse;font-size:11px}th{padding:5px 8px;text-align:left;font-size:9px;font-weight:700;color:#8A8680;text-transform:uppercase;border-bottom:2px solid #E0DDD8}"
          + "td{padding:7px 8px;border-bottom:1px solid #E0DDD8}@media print{body{margin:20px}}";

        const header = "<h1>Aggre/Gator Report</h1>"
          + "<div class='meta'>Generated " + new Date().toLocaleString("en-GB") + " &middot; Date range: " + (rangeLabels[dateRange] ?? dateRange) + " &middot; Section: " + section + "</div>"
          + "<div class='stats'>"
          + "<div class='stat'><div class='val' style='color:#1A1916'>" + (eventStats?.totalGroups.toLocaleString() ?? "—") + "</div><div class='lbl'>Event Groups</div></div>"
          + "<div class='stat'><div class='val' style='color:#1D6B4E'>" + (eventStats?.completed.toLocaleString() ?? "—") + "</div><div class='lbl'>Completed</div></div>"
          + "<div class='stat'><div class='val' style='color:#B45309'>" + (eventStats?.inProgress.toLocaleString() ?? "—") + "</div><div class='lbl'>In Progress</div></div>"
          + "<div class='stat'><div class='val' style='color:#1D4ED8'>" + (eventStats?.totalSegments.toLocaleString() ?? "—") + "</div><div class='lbl'>Segments</div></div>"
          + "</div>";

        let body = "";
        if (section === "overview") {
          const tp = eventStats?.throughput ?? [];
          const avgSegs = (eventStats?.totalGroups ?? 0) > 0 ? (eventStats?.totalSegments ?? 0) / (eventStats?.totalGroups ?? 1) : 2.5;
          const grpData = tp.map(b => ({ bucket: b.bucket, v1: b.opened, v2: b.closed, v3: Math.max(b.opened - b.closed, 0) }));
          const segData = tp.map(b => ({ bucket: b.bucket, v1: Math.round(b.opened * avgSegs), v2: Math.round(b.closed * avgSegs) }));
          const polRows = (eventStats?.byPolicy ?? []).map(p => {
            const rate = p.total ? Math.round((p.completed / p.total) * 100) : 0;
            return "<tr><td>" + p.policyName.replace("EXAMPLE - ", "") + "</td><td>" + p.total + "</td><td>" + p.completed + "</td><td>" + p.inProgress + "</td><td>" + p.totalSegments + "</td><td>" + (p.avgDurationMs ? fmtMs(p.avgDurationMs) : "—") + "</td><td>" + rate + "%</td></tr>";
          }).join("");
          body = "<h2>Throughput</h2>"
            + "<div class='chart'>" + buildSvgChart("Event Group Throughput — Over Time", grpData, "#1D6B4E", "Opened", "#1D4ED8", "Closed", "#B45309", "In Progress") + "</div>"
            + "<div class='chart'>" + buildSvgChart("Segment Throughput — Over Time", segData, "#6D28D9", "Segs Opened", "#8B5CF6", "Segs Closed") + "</div>"
            + "<h2>Policy Breakdown</h2>"
            + "<table><thead><tr><th>Policy</th><th>Total</th><th>Completed</th><th>In Progress</th><th>Segments</th><th>Avg Duration</th><th>Rate</th></tr></thead>"
            + "<tbody>" + polRows + "</tbody></table>";
        } else if (section === "policies") {
          const rows = (eventStats?.byPolicy ?? []).map(p => {
            const rate = p.total ? Math.round((p.completed / p.total) * 100) : 0;
            return "<tr><td>" + p.policyName.replace("EXAMPLE - ", "") + "</td><td>" + p.total + "</td><td>" + p.completed + "</td><td>" + p.inProgress + "</td><td>" + p.totalSegments + "</td><td>" + (p.avgDurationMs ? fmtMs(p.avgDurationMs) : "—") + "</td><td>" + rate + "%</td></tr>";
          }).join("");
          body = "<h2>Policy Statistics</h2>"
            + "<table><thead><tr><th>Policy</th><th>Total</th><th>Completed</th><th>In Progress</th><th>Segments</th><th>Avg Duration</th><th>Rate</th></tr></thead>"
            + "<tbody>" + rows + "</tbody></table>";
        } else {
          const rows = events.map(e => {
            const dur = e.durationMs ? fmtMs(e.durationMs) : "—";
            return "<tr><td style='font-family:monospace;font-size:10px'>" + e.id.slice(0,18) + "…</td><td>" + e.policyName.replace("EXAMPLE - ", "") + "</td><td style='font-family:monospace'>" + e.aggregationKey + "</td><td>" + e.status.replace("_", " ") + "</td><td>" + e.segmentCount + "</td><td>" + dur + "</td></tr>";
          }).join("");
          body = "<h2>Group Explorer (" + events.length + " groups)</h2>"
            + "<table><thead><tr><th>ID</th><th>Policy</th><th>Key</th><th>Status</th><th>Segs</th><th>Duration</th></tr></thead>"
            + "<tbody>" + rows + "</tbody></table>";
        }

        const html = "<!DOCTYPE html><html><head><title>Aggre/Gator Report</title><style>" + css + "</style></head><body>"
          + header + body + "<script>window.onload=function(){window.print();}<\/script></body></html>";
        const blob = new Blob([html], { type: "text/html" });
        window.open(URL.createObjectURL(blob), "_blank");
      }
      setReportExporting(null);
    }, 600);
  }


  function handleExport(format: "CSV" | "JSON") {
    setShowExport(false);
    setExporting(format);
    // Build export from eventStats + current events — in production this would call a backend endpoint
    setTimeout(() => {
      if (format === "CSV") {
        const headers = ["id","policyName","aggregationKey","keyField","status","segmentCount","startTime","endTime","durationMs"];
        const rows = events.map(e => headers.map(h => {
          const v = (e as unknown as Record<string, unknown>)[h];
          return v === null || v === undefined ? "" : String(v).includes(",") ? `"${v}"` : String(v);
        }).join(","));
        const csv = [headers.join(","), ...rows].join("\n");
        const blob = new Blob([csv], { type: "text/csv" });
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `eventagg-export-${Date.now()}.csv`; a.click();
      } else {
        const blob = new Blob([JSON.stringify(events, null, 2)], { type: "application/json" });
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `eventagg-export-${Date.now()}.json`; a.click();
      }
      setExporting(null);
    }, 800);
  }

  // ── Active cols for each tab ───────────────────────────────────────────────
  const activeGroupCols = GROUP_COLS.filter(c => c.key.startsWith("_") || groupVisible.has(c.key));
  const activeSegCols   = SEG_COLS.filter(c => c.key.startsWith("_") || segVisible.has(c.key));

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "Georgia, serif", color: C.text }}>
      <style>{`
        @keyframes slideIn    { from { transform: translateX(100%); } to { transform: translateX(0); } }
        @keyframes pulse      { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        @keyframes flashGreen { 0% { background: ${C.accentLight}; } 70% { background: ${C.accentSoft}; } 100% { background: transparent; } }
        @keyframes flashAmber { 0% { background: ${C.warnLight}; } 100% { background: transparent; } }
        @keyframes slideDown  { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
        .hl-new      { animation: slideDown 0.3s ease, flashGreen 3s ease forwards; }
        .hl-promoted { animation: flashGreen 3s ease forwards; }
        .hl-segment  { animation: flashAmber 3s ease forwards; }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-thumb { background: ${C.borderStrong}; border-radius: 3px; }
        tbody tr:hover td { background: ${C.surfaceAlt}; }
      `}</style>

      {/* Header — full-width bg, content constrained to match main area */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, width: "100%" }}>
        <div style={{ maxWidth: 1400, margin: "0 auto", padding: "0 32px", display: "flex", justifyContent: "space-between", alignItems: "center", height: 56 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
            <JawIcon size={30} />
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", lineHeight: 1 }}>
                <span style={{ fontSize: 19, fontWeight: 900, letterSpacing: "-0.03em", color: C.text, fontFamily: "Georgia, serif" }}>Aggre</span>
                <span style={{ fontSize: 38, fontWeight: 900, color: C.accent, fontFamily: "Georgia, serif", transform: "scaleX(0.9)", display: "inline-block", margin: "0 2px", lineHeight: 0.75 }}>/</span>
                <span style={{ fontSize: 19, fontWeight: 900, letterSpacing: "-0.03em", color: C.text, fontFamily: "Georgia, serif" }}>Gator</span>
              </div>
              <span style={{ fontSize: 11, fontFamily: "monospace", color: C.textMuted, borderLeft: `1.5px solid ${C.border}`, paddingLeft: 10, whiteSpace: "nowrap" as const }}>event streams, swallowed whole</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0, alignItems: "center" }}>
            <button onClick={() => setAutoRefresh(r => !r)} style={{ padding: "7px 14px", fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: "pointer", fontFamily: "inherit", border: `1px solid ${autoRefresh ? C.accent : C.border}`, background: autoRefresh ? C.accentLight : C.surface, color: autoRefresh ? C.accent : C.textMid, display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: autoRefresh ? C.accent : C.borderStrong, display: "inline-block", animation: autoRefresh ? "pulse 2s infinite" : "none" }} />
              {autoRefresh ? "Live · 10s" : "Auto-refresh"}
            </button>
            <div style={{ display: "flex", background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 7, padding: 2 }}>
              {(["events", "reports"] as const).map(v => (
                <button key={v} onClick={() => setView(v)}
                  style={{ padding: "5px 14px", border: "none", borderRadius: 5, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: view === v ? 700 : 400, color: view === v ? C.accent : C.textMid, background: view === v ? C.surface : "none", boxShadow: view === v ? "0 1px 3px rgba(0,0,0,0.08)" : "none", transition: "all 0.15s", textTransform: "capitalize" as const }}>
                  {v === "events" ? "Event Groups" : "Reports"}
                </button>
              ))}
            </div>
            {sessionUser.role !== "viewer" && (
              <button onClick={() => setShowIngest(true)} style={{ padding: "7px 16px", fontSize: 12, fontWeight: 700, borderRadius: 6, cursor: "pointer", border: "none", background: C.accent, color: "#fff", fontFamily: "inherit" }}>+ Ingest Event</button>
            )}
            <span style={{ fontSize: 11, color: C.textMuted, fontFamily: "monospace" }}>{sessionUser?.username}</span>
            <BurgerMenu
              user={sessionUser!}
              policies={policies}
              appUsers={appUsers}
              onSignOut={onLogout}
              onUsersChanged={onUsersChanged}
              onOpenPolicies={() => setShowPolicies(true)}
            />
          </div>
        </div>
      </div>

      <div style={{ padding: "28px 32px", maxWidth: 1400, margin: "0 auto" }}>

        {/* ── Reports view ── */}
        {view === "reports" && (
          <>
          <StatsBar events={events} eventsTotal={eventStats?.totalGroups ?? eventsTotal} policies={policies} eventStats={eventStats} />

          {/* Filter bar — status greyed out for Reports */}
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px", marginBottom: 14 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {/* Status — disabled in Reports, doesn't affect aggregate metrics */}
              <div title="Status filter does not affect report metrics — reports always show aggregate data across all groups"
                style={{ padding: "6px 28px 6px 10px", border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, color: C.textMuted, background: "#ECEAE6", cursor: "not-allowed", opacity: 0.5, userSelect: "none" as const, display: "flex", alignItems: "center", gap: 6, flexShrink: 0, whiteSpace: "nowrap" as const }}>
                All statuses
                <span style={{ fontSize: 9, background: C.border, borderRadius: 3, padding: "0px 5px", color: C.textMuted, fontWeight: 700 }}>n/a</span>
              </div>
              <PolicyMultiSelect policies={policies} selected={policyFilter} onChange={v => { setPolicyFilter(v); setPage(1); }} />
              <CompactSelect value={dateRange} onChange={applyDateRange}
                options={[{ value: "all", label: "All time" }, { value: "24h", label: "Last 24h" }, { value: "7d", label: "Last 7d" }, { value: "30d", label: "Last 30d" }, { value: "6m", label: "Last 6m" }, { value: "custom", label: "Custom…" }]} />
              <div style={{ width: 1, height: 24, background: C.border, flexShrink: 0 }} />
              <ExpandingInput label="Key" value={keyFilter} onChange={setKeyFilter} placeholder="TRD-9001 / sess-U001…" />
              {reportSection === "explorer" && (
                <ExpandingInput label="Body" value={bodySearch} onChange={v => { setBodySearch(v); setPage(1); }}
                  placeholder='trader=t-smith or "t-smith"' mono
                  helpContent={
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 800, color: C.text, marginBottom: 10 }}>Body Search</div>
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: C.accent, marginBottom: 4, textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>⬡ Field match — field=value</div>
                        {["trader=t-smith", "symbol=AAPL", "statusCode=200"].map(ex => (
                          <button key={ex} onClick={() => { setBodySearch(ex); setPage(1); }}
                            style={{ display: "block", padding: "3px 8px", marginBottom: 3, background: C.accentLight, border: `1px solid ${C.accentSoft}`, borderRadius: 4, fontSize: 11, fontFamily: "monospace", cursor: "pointer", color: C.accent, width: "100%", textAlign: "left" as const }}>{ex}</button>
                        ))}
                      </div>
                      <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: C.info, marginBottom: 4, textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>⟡ Full-text — any string</div>
                        {["t-smith", "slow response"].map(ex => (
                          <button key={ex} onClick={() => { setBodySearch(ex); setPage(1); }}
                            style={{ display: "block", padding: "3px 8px", marginBottom: 3, background: C.infoLight, border: `1px solid ${C.info}30`, borderRadius: 4, fontSize: 11, fontFamily: "monospace", cursor: "pointer", color: C.info, width: "100%", textAlign: "left" as const }}>"{ex}"</button>
                        ))}
                      </div>
                    </div>
                  }
                />
              )}
              <div style={{ width: 1, height: 24, background: C.border, flexShrink: 0 }} />
              {(policyFilter.length > 0 || keyFilter || dateRange !== "24h" || bodySearch)
                ? <button onClick={clearFilters} style={{ padding: "5px 12px", border: `1px solid ${C.border}`, borderRadius: 6, background: "none", cursor: "pointer", fontSize: 11, color: C.textMid, fontFamily: "inherit", flexShrink: 0, whiteSpace: "nowrap" as const }}>Clear all</button>
                : <span style={{ fontSize: 11, color: C.textMuted, flexShrink: 0 }}>No filters</span>
              }
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: C.textMuted, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>{loading ? "Loading…" : `${eventsTotal} total event groups · `}<span style={{ color: C.accent }}>Status filter not applicable in Reports</span></span>
              {autoRefresh && <span style={{ fontSize: 10, color: C.accent, fontFamily: "monospace", display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: C.accent, display: "inline-block" }} />refreshing every 10s</span>}
            </div>
          </div>

          {/* Report card */}
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1px solid ${C.border}`, padding: "0 16px" }}>
              <div style={{ display: "flex" }}>
                {(["overview", "policies", "explorer", "audit"] as const).map(s => (
                  <button key={s} onClick={() => setReportSection(s)}
                    style={{ padding: "10px 18px", fontSize: 12, fontWeight: 600, fontFamily: "inherit", border: "none", background: "none", cursor: "pointer", color: reportSection === s ? C.accent : C.textMuted, borderBottom: `2px solid ${reportSection === s ? C.accent : "transparent"}`, marginBottom: -1, transition: "color 0.15s" }}>
                    {s === "overview" ? "Overview" : s === "policies" ? "Policy Stats" : s === "explorer" ? "Event Group Performance" : "Audit Log"}
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 10, color: C.textMuted, fontFamily: "monospace" }}>
                  {reportSection === "overview"  && `groups opened vs closed · ${{ "all": "all time", "24h": "last 24h", "7d": "last 7 days", "30d": "last 30 days", "6m": "last 6 months" }[dateRange] ?? dateRange}`}
                  {reportSection === "policies"  && "avg · p50 · p95 durations per policy"}
                  {reportSection === "explorer"  && "click Timeline → to inspect a group"}
                </span>
                {(
                  <>
                    <div style={{ width: 1, height: 20, background: C.border }} />
                    {/* Export button — all report sections */}
                    <div style={{ position: "relative" }}>
                      <button onClick={() => setShowReportExport(v => !v)}
                        style={{ padding: "5px 10px", fontSize: 11, fontWeight: 600, border: `1px solid ${C.border}`, borderRadius: 5, background: reportExporting ? C.accentLight : showReportExport ? C.surfaceAlt : C.surface, cursor: "pointer", fontFamily: "inherit", color: reportExporting ? C.accent : C.textMid, display: "flex", alignItems: "center", gap: 5 }}>
                        {reportExporting ? <><span style={{ width: 7, height: 7, borderRadius: "50%", background: C.accent, display: "inline-block" }} />Exporting…</> : <><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 2v9M5 8l3 3 3-3M2 13h12"/></svg>Export</>}
                      </button>
                      {showReportExport && (
                        <div style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: "0 4px 20px rgba(0,0,0,0.12)", zIndex: 50, minWidth: 210, padding: "6px" }}>
                          <div style={{ padding: "4px 10px 6px", fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.07em" }}>
                            Export {reportSection === "overview" ? "Overview" : reportSection === "policies" ? "Policy Stats" : "Event Group Performance"}
                          </div>
                          {([
                            { fmt: "PDF",  icon: "📄", desc: reportSection === "overview" ? "Summary + charts · printable" : "Table report · printable" },
                            { fmt: "JSON", icon: "{ }", desc: "Raw aggregated metrics data" },
                          ]).map(opt => (
                            <button key={opt.fmt} onClick={() => handleReportExport(opt.fmt as "PDF" | "JSON")}
                              style={{ width: "100%", padding: "7px 10px", border: "none", borderRadius: 6, background: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left" as const, display: "flex", gap: 10, alignItems: "flex-start" }}
                              onMouseEnter={e => (e.currentTarget.style.background = C.surfaceAlt)}
                              onMouseLeave={e => (e.currentTarget.style.background = "none")}>
                              <span style={{ fontSize: 13, lineHeight: "1.3", flexShrink: 0 }}>{opt.icon}</span>
                              <div><div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{opt.fmt}</div><div style={{ fontSize: 10, color: C.textMuted, marginTop: 1 }}>{opt.desc}</div></div>
                            </button>
                          ))}
                          <div style={{ borderTop: `1px solid ${C.border}`, margin: "4px 0 0", padding: "5px 10px 3px" }}>
                            <div style={{ fontSize: 10, color: C.textMuted }}>Respects current filters and date range</div>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
            {reportSection === "overview"  && <ReportsOverview  policies={policies} stats={eventStats} dateRange={dateRange} policyFilter={policyFilter} />}
            {reportSection === "policies"  && <ReportsPolicyStats policies={policies} stats={eventStats} />}
            {reportSection === "explorer"  && <ReportsGroupExplorer policies={policies} policyFilter={policyFilter} keyFilter={keyFilter} fromFilter={fromFilter} toFilter={toFilter} />}
            {reportSection === "audit"     && <AuditLogView />}
          </div>
          </>
        )}

        {/* ── Events view ── */}
        {view === "events" && (<>
        <StatsBar events={events} eventsTotal={eventsTotal} policies={policies} eventStats={eventStats} />

        {/* Filters — single row */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px", marginBottom: 14 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <StatusMultiSelect selected={statusFilter} onChange={v => { setStatusFilter(v); setPage(1); }} />
            <PolicyMultiSelect policies={policies} selected={policyFilter} onChange={v => { setPolicyFilter(v); setPage(1); }} />
            <CompactSelect value={dateRange} onChange={applyDateRange}
              options={[{ value: "all", label: "All time" }, { value: "24h", label: "Last 24h" }, { value: "7d", label: "Last 7d" }, { value: "30d", label: "Last 30d" }, { value: "6m", label: "Last 6m" }, { value: "custom", label: "Custom…" }]} />
            {dateRange === "custom" && <>
              <CompactSelect value={fromFilter.slice(0, 10) || "from"} onChange={v => { setFromFilter(v ? `${v}T00:00:00.000Z` : ""); setPage(1); }}
                options={[{ value: "from", label: "From…" }]} />
              <CompactSelect value={toFilter.slice(0, 10) || "to"} onChange={v => { setToFilter(v ? `${v}T23:59:59.999Z` : ""); setPage(1); }}
                options={[{ value: "to", label: "To…" }]} />
            </>}
            <div style={{ width: 1, height: 24, background: C.border, flexShrink: 0 }} />
            <ExpandingInput label="Key" value={keyFilter} onChange={setKeyFilter} placeholder="TRD-9001 / sess-U001…" />
            <ExpandingInput label="Body" value={bodySearch} onChange={v => { setBodySearch(v); setPage(1); }}
              placeholder='trader=t-smith  or  "t-smith"' mono
              helpContent={
                <div>
                  <div style={{ fontSize: 11, fontWeight: 800, color: C.text, marginBottom: 10 }}>Body Search</div>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: C.accent, marginBottom: 4, textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>⬡ Field match — field=value</div>
                    <div style={{ fontSize: 11, color: C.textMid, marginBottom: 6 }}>Precise GIN-indexed match. Supports dot-notation.</div>
                    {["trader=t-smith", "symbol=AAPL", "statusCode=200", "userId=usr-001"].map(ex => (
                      <button key={ex} onClick={() => { setBodySearch(ex); setPage(1); }}
                        style={{ display: "block", padding: "3px 8px", marginBottom: 3, background: C.accentLight, border: `1px solid ${C.accentSoft}`, borderRadius: 4, fontSize: 11, fontFamily: "monospace", cursor: "pointer", color: C.accent, width: "100%", textAlign: "left" as const }}>
                        {ex}
                      </button>
                    ))}
                  </div>
                  <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: C.info, marginBottom: 4, textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>⟡ Full-text — any string</div>
                    <div style={{ fontSize: 11, color: C.textMid, marginBottom: 6 }}>Searches the entire serialised body.</div>
                    {["t-smith", "WH-02", "slow response"].map(ex => (
                      <button key={ex} onClick={() => { setBodySearch(ex); setPage(1); }}
                        style={{ display: "block", padding: "3px 8px", marginBottom: 3, background: C.infoLight, border: `1px solid ${C.info}30`, borderRadius: 4, fontSize: 11, fontFamily: "monospace", cursor: "pointer", color: C.info, width: "100%", textAlign: "left" as const }}>
                        "{ex}"
                      </button>
                    ))}
                  </div>
                </div>
              }
            />
            <div style={{ width: 1, height: 24, background: C.border, flexShrink: 0 }} />
            {(statusFilter.length > 0 || policyFilter.length > 0 || keyFilter || dateRange !== "24h" || bodySearch)
              ? <button onClick={clearFilters} style={{ padding: "5px 12px", border: `1px solid ${C.border}`, borderRadius: 6, background: "none", cursor: "pointer", fontSize: 11, color: C.textMid, fontFamily: "inherit", flexShrink: 0, whiteSpace: "nowrap" as const }}>Clear all</button>
              : <span style={{ fontSize: 11, color: C.textMuted, flexShrink: 0 }}>No filters</span>
            }
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: C.textMuted, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{loading ? "Loading…" : `${eventsTotal} total event groups`}{" · "}<span style={{ fontFamily: "monospace", color: C.accent }}>GET /api/v1/events?status={statusFilter.length === 1 ? statusFilter[0] : "all"}{keyFilter && `&aggregationKey=${keyFilter}`}{policyFilter.length === 1 && `&policyId=${policyFilter[0]}`}{fromFilter && `&from=${fromFilter}`}{toFilter && `&to=${toFilter}`}{bodySearch && `&bodySearch=${encodeURIComponent(bodySearch)}`}&page={page}</span></span>
            {autoRefresh && <span style={{ fontSize: 10, color: C.accent, fontFamily: "monospace", display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: C.accent, display: "inline-block" }} />refreshing every 10s</span>}
          </div>
        </div>

        {/* Table card */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>

          {/* Tab bar + column toggle */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1px solid ${C.border}`, padding: "0 16px" }}>
            <div style={{ display: "flex" }}>
              {(["groups", "segments"] as const).map(tab => (
                <button key={tab} onClick={() => setActiveTab(tab)}
                  style={{ padding: "10px 18px", fontSize: 12, fontWeight: 600, fontFamily: "inherit", border: "none", background: "none", cursor: "pointer", color: activeTab === tab ? C.accent : C.textMuted, borderBottom: `2px solid ${activeTab === tab ? C.accent : "transparent"}`, marginBottom: -1, transition: "color 0.15s" }}>
                  {tab === "groups" ? "Event Groups" : "Segments"}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {/* Rows per page */}
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 11, color: C.textMuted, whiteSpace: "nowrap" as const }}>Rows per page</span>
                <div style={{ position: "relative" }}>
                  <select value={perPage} onChange={e => handlePerPageChange(Number(e.target.value))}
                    style={{ appearance: "none" as const, border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 22px 4px 8px", fontSize: 11, fontFamily: "inherit", fontWeight: 600, color: C.textMid, background: C.surfaceAlt, cursor: "pointer", outline: "none" }}>
                    {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                  <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke={C.textMuted} strokeWidth="2"
                    style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
                    <path d="M4 6l4 4 4-4"/>
                  </svg>
                </div>
              </div>
              <div style={{ width: 1, height: 20, background: C.border }} />
              {/* Export button */}
              <div style={{ position: "relative" }}>
                <button onClick={() => setShowExport(v => !v)}
                  style={{ padding: "5px 10px", fontSize: 11, fontWeight: 600, border: `1px solid ${C.border}`, borderRadius: 5, background: exporting ? C.accentLight : showExport ? C.surfaceAlt : C.surface, cursor: "pointer", fontFamily: "inherit", color: exporting ? C.accent : C.textMid, display: "flex", alignItems: "center", gap: 5 }}>
                  {exporting ? (
                    <><span style={{ width: 7, height: 7, borderRadius: "50%", background: C.accent, display: "inline-block" }} />Exporting {exporting}…</>
                  ) : (
                    <><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 2v9M5 8l3 3 3-3M2 13h12"/></svg>Export</>
                  )}
                </button>
                {showExport && (
                  <div style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: "0 4px 20px rgba(0,0,0,0.12)", zIndex: 50, minWidth: 240, padding: "6px" }}>
                    <div style={{ padding: "6px 10px 4px", fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.07em" }}>
                      Export {eventsTotal.toLocaleString()} event groups
                    </div>
                    {([
                      { format: "CSV"  as const, icon: "📄", desc: "Flat file — one row per group, all columns" },
                      { format: "JSON" as const, icon: "{ }", desc: "Full detail — groups with nested segments" },
                    ]).map(opt => (
                      <button key={opt.format} onClick={() => handleExport(opt.format)}
                        style={{ width: "100%", padding: "8px 10px", border: "none", borderRadius: 6, background: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left" as const, display: "flex", gap: 10, alignItems: "flex-start" }}
                        onMouseEnter={e => (e.currentTarget.style.background = C.surfaceAlt)}
                        onMouseLeave={e => (e.currentTarget.style.background = "none")}>
                        <span style={{ fontSize: 13, lineHeight: "1.3", flexShrink: 0 }}>{opt.icon}</span>
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{opt.format}</div>
                          <div style={{ fontSize: 10, color: C.textMuted, marginTop: 1 }}>{opt.desc}</div>
                        </div>
                      </button>
                    ))}
                    <div style={{ borderTop: `1px solid ${C.border}`, margin: "4px 0 0", padding: "6px 10px 4px" }}>
                      <div style={{ fontSize: 10, color: C.textMuted }}>Current filters apply · exports what you see</div>
                    </div>
                  </div>
                )}
              </div>
              <div style={{ position: "relative" }}>
              <button onClick={() => setShowColMenu(v => !v)}
                style={{ padding: "5px 10px", fontSize: 11, fontWeight: 600, border: `1px solid ${C.border}`, borderRadius: 5, background: showColMenu ? C.surfaceAlt : C.surface, cursor: "pointer", fontFamily: "inherit", color: C.textMid, display: "flex", alignItems: "center", gap: 5 }}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1" y="1" width="4" height="14" rx="1"/><rect x="7" y="1" width="4" height="14" rx="1"/><rect x="13" y="1" width="2" height="14" rx="1"/></svg>
                Columns
              </button>
              {showColMenu && (
                <ColVisMenu
                  cols={activeTab === "groups" ? GROUP_COLS : SEG_COLS}
                  visible={activeTab === "groups" ? groupVisible : segVisible}
                  onToggle={activeTab === "groups" ? k => setGroupVisible(v => { const n = new Set(v); n.has(k) ? n.delete(k) : n.add(k); return n; }) : k => setSegVisible(v => { const n = new Set(v); n.has(k) ? n.delete(k) : n.add(k); return n; })}
                  onClose={() => setShowColMenu(false)}
                />
              )}
              </div>
            </div>
          </div>

          {/* ── EVENT GROUPS TAB ── */}
          {activeTab === "groups" && (
            <div style={{ overflowX: "auto" }}>
              {loading  && <div style={{ padding: 48, textAlign: "center", color: C.textMuted, fontSize: 14 }}>Loading events…</div>}
              {loadError && <div style={{ padding: 48, textAlign: "center", color: C.danger, fontSize: 14 }}>{loadError}</div>}
              {!loading && !loadError && (
                <table style={{ borderCollapse: "collapse", width: "100%", tableLayout: "fixed" }}>
                  <colgroup>{activeGroupCols.map(c => <col key={c.key} style={{ width: groupWidths[c.key] ?? c.defaultWidth }} />)}</colgroup>
                  <thead>
                    <tr style={{ background: C.surfaceAlt }}>
                      {activeGroupCols.map((col, i) => <ResizableTh key={col.key} col={col} widths={groupWidths} setWidths={setGroupWidths} isLast={i === activeGroupCols.length - 1} />)}
                    </tr>
                  </thead>
                  <tbody>
                    {events.length === 0 && (
                      <tr><td colSpan={activeGroupCols.length} style={{ padding: 48, textAlign: "center", color: C.textMuted, fontSize: 14 }}>No events match your filters.</td></tr>
                    )}
                    {events.map(ev => (
                      <tr key={ev.id} style={{ cursor: "pointer" }}
                        className={(() => { const h = highlighted.find(h => h.id === ev.id); return h ? `hl-${h.reason}` : ""; })()}
                        onClick={() => openDetail(ev.id)}>
                        {groupVisible.has("id")        && <td style={{ padding: "10px 10px", overflow: "hidden" }}><code style={{ fontSize: 11, fontFamily: "monospace", color: C.accent, fontWeight: 700, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ev.id}</code></td>}
                        {groupVisible.has("policy")    && <td style={{ padding: "10px 10px", overflow: "hidden" }}><span style={{ background: C.purpleLight, color: C.purple, padding: "2px 6px", borderRadius: 3, fontSize: 10, fontWeight: 700, fontFamily: "monospace", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ev.policyName}</span></td>}
                        {groupVisible.has("key")       && <td style={{ padding: "10px 10px", overflow: "hidden" }}><span style={{ background: C.surfaceAlt, color: C.textMid, padding: "2px 6px", borderRadius: 3, fontSize: 11, fontFamily: "monospace", border: `1px solid ${C.border}`, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ev.aggregationKey}</span></td>}
                        {groupVisible.has("source")    && <td style={{ padding: "10px 10px", overflow: "hidden" }}><span style={{ fontSize: 10, color: C.info, fontFamily: "monospace", whiteSpace: "nowrap" }}>←body.{ev.keyField}</span></td>}
                        {groupVisible.has("status")    && <td style={{ padding: "10px 10px" }}><StatusBadge status={ev.status} /></td>}
                        {groupVisible.has("startTime") && <td style={{ padding: "10px 10px" }}><span style={{ fontSize: 11, color: C.textMid }}>{fmt(ev.startTime)}</span></td>}
                        {groupVisible.has("segs")      && <td style={{ padding: "10px 10px", textAlign: "center" }}><span style={{ fontSize: 11, color: C.textMid }}>{ev.segmentCount}</span></td>}
                        <td style={{ padding: "10px 10px", textAlign: "center" }}><span style={{ fontSize: 13, color: C.textMuted }}>›</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* ── SEGMENTS TAB ── */}
          {activeTab === "segments" && (
            <div style={{ overflowX: "auto" }}>
              {segsLoading && <div style={{ padding: 48, textAlign: "center", color: C.textMuted, fontSize: 14 }}>Loading segments…</div>}
              {!segsLoading && (
                <table style={{ borderCollapse: "collapse", width: "100%", tableLayout: "fixed" }}>
                  <colgroup>{activeSegCols.map(c => <col key={c.key} style={{ width: segWidths[c.key] ?? c.defaultWidth }} />)}</colgroup>
                  <thead>
                    <tr style={{ background: C.surfaceAlt }}>
                      {activeSegCols.map((col, i) => <ResizableTh key={col.key} col={col} widths={segWidths} setWidths={setSegWidths} isLast={i === activeSegCols.length - 1} />)}
                    </tr>
                  </thead>
                  <tbody>
                    {segments.length === 0 && (
                      <tr><td colSpan={activeSegCols.length} style={{ padding: 48, textAlign: "center", color: C.textMuted, fontSize: 14 }}>No segments to display. Switch to Event Groups tab and ensure events are loaded.</td></tr>
                    )}
                    {segments.slice((segPage - 1) * PER_PAGE, segPage * PER_PAGE).map(seg => (
                      <tr key={seg.eventId} style={{ cursor: "pointer" }} onClick={() => openDetail(seg.groupId, seg.eventId)}>
                        {segVisible.has("id")         && <td style={{ padding: "10px 10px", overflow: "hidden" }}><code style={{ fontSize: 11, fontFamily: "monospace", color: C.accent, fontWeight: 700, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{seg.eventId}</code></td>}
                        {segVisible.has("groupId")    && <td style={{ padding: "10px 10px", overflow: "hidden" }}><code style={{ fontSize: 10, fontFamily: "monospace", color: C.textMid, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{seg.groupId}</code></td>}
                        {segVisible.has("policy")     && <td style={{ padding: "10px 10px", overflow: "hidden" }}><span style={{ background: C.purpleLight, color: C.purple, padding: "2px 6px", borderRadius: 3, fontSize: 10, fontWeight: 700, fontFamily: "monospace", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{seg.policyName}</span></td>}
                        {segVisible.has("aggKey")     && <td style={{ padding: "10px 10px", overflow: "hidden" }}><span style={{ background: C.surfaceAlt, color: C.textMid, padding: "2px 6px", borderRadius: 3, fontSize: 11, fontFamily: "monospace", border: `1px solid ${C.border}`, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{seg.aggregationKey}</span></td>}
                        {segVisible.has("seq")        && <td style={{ padding: "10px 10px", textAlign: "center" }}><span style={{ fontSize: 11, fontFamily: "monospace", color: C.textMid, fontWeight: 700 }}>{seg.sequence}</span></td>}
                        {segVisible.has("type")       && <td style={{ padding: "10px 10px", overflow: "hidden" }}><code style={{ fontSize: 11, fontFamily: "monospace", color: C.text, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(seg.body.eventType ?? seg.body.status ?? Object.keys(seg.body)[0] ?? "—")}</code></td>}
                        {segVisible.has("cradle")     && <td style={{ padding: "10px 10px" }}><BoolBadge val={seg.isCradle} trueLabel="▶ CRADLE" trueColor={C.accent} /></td>}
                        {segVisible.has("grave")      && <td style={{ padding: "10px 10px" }}><BoolBadge val={seg.isGrave}  trueLabel="■ GRAVE"  trueColor={C.danger} /></td>}
                        {segVisible.has("receivedAt") && <td style={{ padding: "10px 10px" }}><span style={{ fontSize: 11, color: C.textMid }}>{fmt(seg.timestamp)}</span></td>}
                        <td style={{ padding: "10px 10px", textAlign: "center" }}><span style={{ fontSize: 13, color: C.textMuted }}>›</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>

        {/* Pagination — groups tab */}
        {activeTab === "groups" && totalPages > 1 && (
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 6, marginTop: 14 }}>
            <Btn label="← Prev" onClick={() => setPage(p => Math.max(1, p - 1))} small />
            {page > 2 && <button onClick={() => setPage(1)} style={{ padding: "4px 10px", border: `1px solid ${C.border}`, borderRadius: 5, background: C.surface, cursor: "pointer", color: C.text, fontSize: 11, fontFamily: "inherit" }}>1</button>}
            {page > 3 && <span style={{ fontSize: 11, color: C.textMuted, padding: "0 2px" }}>…</span>}
            {[page - 1, page, page + 1].filter(p => p >= 1 && p <= totalPages).map(p => (
              <button key={p} onClick={() => setPage(p)} style={{ padding: "4px 10px", border: `1px solid ${p === page ? C.accent : C.border}`, borderRadius: 5, background: p === page ? C.accentLight : C.surface, cursor: "pointer", color: p === page ? C.accent : C.text, fontSize: 11, fontWeight: p === page ? 700 : 400, fontFamily: "inherit" }}>{p}</button>
            ))}
            {page < totalPages - 2 && <span style={{ fontSize: 11, color: C.textMuted, padding: "0 2px" }}>…</span>}
            {page < totalPages - 1 && <button onClick={() => setPage(totalPages)} style={{ padding: "4px 10px", border: `1px solid ${C.border}`, borderRadius: 5, background: C.surface, cursor: "pointer", color: C.text, fontSize: 11, fontFamily: "inherit" }}>{totalPages}</button>}
            <Btn label="Next →" onClick={() => setPage(p => Math.min(totalPages, p + 1))} small />
            <span style={{ fontSize: 11, color: C.textMuted, marginLeft: 4 }}>Page {page} of {totalPages}</span>
          </div>
        )}

        {/* Pagination — segments tab */}
        {activeTab === "segments" && segments.length > PER_PAGE && (() => {
          const segTotalPages = Math.ceil(segments.length / PER_PAGE);
          return (
            <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 6, marginTop: 14 }}>
              <Btn label="← Prev" onClick={() => setSegPage(p => Math.max(1, p - 1))} small />
              {segPage > 2 && <button onClick={() => setSegPage(1)} style={{ padding: "4px 10px", border: `1px solid ${C.border}`, borderRadius: 5, background: C.surface, cursor: "pointer", color: C.text, fontSize: 11, fontFamily: "inherit" }}>1</button>}
              {segPage > 3 && <span style={{ fontSize: 11, color: C.textMuted, padding: "0 2px" }}>…</span>}
              {[segPage - 1, segPage, segPage + 1].filter(p => p >= 1 && p <= segTotalPages).map(p => (
                <button key={p} onClick={() => setSegPage(p)} style={{ padding: "4px 10px", border: `1px solid ${p === segPage ? C.accent : C.border}`, borderRadius: 5, background: p === segPage ? C.accentLight : C.surface, cursor: "pointer", color: p === segPage ? C.accent : C.text, fontSize: 11, fontWeight: p === segPage ? 700 : 400, fontFamily: "inherit" }}>{p}</button>
              ))}
              {segPage < segTotalPages - 2 && <span style={{ fontSize: 11, color: C.textMuted, padding: "0 2px" }}>…</span>}
              {segPage < segTotalPages - 1 && <button onClick={() => setSegPage(segTotalPages)} style={{ padding: "4px 10px", border: `1px solid ${C.border}`, borderRadius: 5, background: C.surface, cursor: "pointer", color: C.text, fontSize: 11, fontFamily: "inherit" }}>{segTotalPages}</button>}
              <Btn label="Next →" onClick={() => setSegPage(p => Math.min(segTotalPages, p + 1))} small />
              <span style={{ fontSize: 11, color: C.textMuted, marginLeft: 4 }}>Page {segPage} of {segTotalPages}</span>
            </div>
          );
        })()}

        {/* Legend */}
        <div style={{ display: "flex", gap: 16, marginTop: 20, justifyContent: "center", flexWrap: "wrap" }}>
          {[{ color: C.accent, bg: C.accentLight, label: "completed_events — durable (WAL)" }, { color: C.warn, bg: C.warnLight, label: "in_progress_events — hot" }, { color: C.purple, bg: C.purpleLight, label: "Policy-driven — key, cradle & grave from body" }, { color: C.info, bg: C.infoLight, label: "⬡ Key path resolved from segment body" }].map(({ color, bg, label }) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: C.textMuted }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: bg, border: `1px solid ${color}`, display: "inline-block" }} />
              {label}
            </div>
          ))}
        </div>
        </>)}
      </div>

      {selected && <EventDetail event={selected} policy={policies.find(p => p.id === selected.policyId)} onClose={() => { setSelected(null); setFocusSegmentId(undefined); }} initialSegmentId={focusSegmentId} />}
      {showPolicies && <PoliciesPanel policies={policies} onSave={savePolicy} onDelete={deletePolicy} onToggle={togglePolicy} onClose={() => setShowPolicies(false)} />}
      {showIngest && <IngestModal policies={policies} onIngest={handleIngest} onClose={() => setShowIngest(false)} />}
    </div>
  );
}
