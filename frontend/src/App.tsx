import { useState, useEffect, useCallback, useRef } from "react";
import {
  api,
  Policy,
  EventGroupSummary,
  EventGroupDetail,
  SegmentDetail,
  IngestResult,
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
  return status === "completed"
    ? <Badge label="● Completed" bg={C.accentLight} color={C.accent} />
    : <Badge label="◐ In Progress" bg={C.warnLight} color={C.warn} />;
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
  cradleField: string; cradleValue: string; graveField: string; graveValue: string; description: string;
}
const blankPolicy = (): PolicyForm => ({ name: "", domain: "*", keyField: "", cradleField: "eventType", cradleValue: "", graveField: "eventType", graveValue: "", description: "" });

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
function PoliciesPanel({ policies, onSave, onDelete, onClose }: {
  policies: Policy[]; onSave: (p: PolicyForm) => Promise<void>; onDelete: (id: string) => Promise<void>; onClose: () => void;
}) {
  const [editing, setEditing] = useState<PolicyForm | null>(null);
  const toForm = (p: Policy): PolicyForm => ({ id: p.id, name: p.name, domain: p.domain, keyField: p.keyField, cradleField: p.cradleField, cradleValue: p.cradleValue, graveField: p.graveField, graveValue: p.graveValue, description: p.description ?? "" });
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(26,25,22,0.45)", zIndex: 100, display: "flex", alignItems: "flex-start", justifyContent: "flex-end" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: 560, height: "100vh", background: C.surface, borderLeft: `1px solid ${C.border}`, overflowY: "auto", display: "flex", flexDirection: "column", animation: "slideIn 0.2s ease" }}>
        <div style={{ padding: "18px 24px 14px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, background: C.surface, zIndex: 1 }}>
          <div><div style={{ fontSize: 16, fontWeight: 800 }}>Aggregation Policies</div><div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{policies.length} configured</div></div>
          <div style={{ display: "flex", gap: 8 }}><Btn label="+ New Policy" onClick={() => setEditing(blankPolicy())} variant="primary" small /><button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.textMuted }}>×</button></div>
        </div>
        <div style={{ padding: "16px 24px", flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>
          {policies.map(pol => (
            <div key={pol.id} style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", background: C.surfaceAlt, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}><span style={{ fontSize: 13, fontWeight: 800 }}>{pol.name}</span><code style={{ fontSize: 10, color: C.textMuted, background: C.surface, padding: "1px 6px", borderRadius: 3, border: `1px solid ${C.border}` }}>{pol.domain}</code></div>
                  <div style={{ fontSize: 11, color: C.textMuted }}>{pol.description}</div>
                  <CopyableId id={pol.id} />
                </div>
                <Btn label="Edit" onClick={() => setEditing(toForm(pol))} small />
              </div>
              <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 7 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}><span style={{ fontSize: 10, fontWeight: 700, color: C.info, minWidth: 36 }}>⬡</span><ConditionPill label="KEY" field={`body.${pol.keyField}`} color={C.info} /><span style={{ fontSize: 10, color: C.textMuted }}>→ aggregation key</span></div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}><span style={{ fontSize: 10, fontWeight: 700, color: C.accent, minWidth: 36 }}>▶</span><ConditionPill label="IF" field={`body.${pol.cradleField}`} value={pol.cradleValue} color={C.accent} /><span style={{ fontSize: 10, color: C.textMuted }}>→ open group</span></div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}><span style={{ fontSize: 10, fontWeight: 700, color: C.danger, minWidth: 36 }}>■</span><ConditionPill label="IF" field={`body.${pol.graveField}`} value={pol.graveValue} color={C.danger} /><span style={{ fontSize: 10, color: C.textMuted }}>→ close group</span></div>
              </div>
            </div>
          ))}
          {policies.length === 0 && <div style={{ padding: 32, textAlign: "center", color: C.textMuted, fontSize: 13 }}>No policies yet. Create one to start ingesting events.</div>}
        </div>
        <div style={{ padding: "12px 24px", borderTop: `1px solid ${C.border}`, background: C.surfaceAlt }}>
          <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 4, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>Policy API</div>
          {["GET /api/v1/policies", "POST /api/v1/policies", "PUT /api/v1/policies/:id", "DELETE /api/v1/policies/:id"].map(e => <div key={e} style={{ fontSize: 11, fontFamily: "monospace", color: C.accent }}>{e}</div>)}
        </div>
      </div>
      {editing && <PolicyEditor policy={editing} onSave={onSave} onDelete={editing.id ? () => onDelete(editing.id!) : undefined} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ─── Event Detail Panel ───────────────────────────────────────────────────────
function EventDetail({ event, policy, onClose }: { event: EventGroupDetail; policy: Policy | undefined; onClose: () => void }) {
  const [openSeg, setOpenSeg] = useState<number | null>(null);
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(26,25,22,0.45)", zIndex: 100, display: "flex", alignItems: "flex-start", justifyContent: "flex-end" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: 520, height: "100vh", background: C.surface, borderLeft: `1px solid ${C.border}`, overflowY: "auto", display: "flex", flexDirection: "column", animation: "slideIn 0.2s ease" }}>
        <div style={{ padding: "18px 24px 14px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start", position: "sticky", top: 0, background: C.surface, zIndex: 1 }}>
          <div>
            <div style={{ fontSize: 11, color: C.textMuted, fontFamily: "monospace", marginBottom: 4 }}>EVENT GROUP</div>
            <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "monospace" }}>{event.id}</div>
            <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}><StatusBadge status={event.status} /><Badge label={`⚙ ${event.policyName}`} bg={C.purpleLight} color={C.purple} /></div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.textMuted }}>×</button>
        </div>
        <div style={{ padding: "14px 24px", borderBottom: `1px solid ${C.border}`, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {([["Aggregation Key", event.aggregationKey, true], ["Key Source", `body.${event.keyField}`, true], ["Start", fmt(event.startTime), false], ["End", fmt(event.endTime), false], ["Duration", fmtDur(event.startTime, event.endTime), false], ["Store", event.status === "completed" ? "completed_events" : "in_progress_events", true]] as [string, string, boolean][]).map(([k, v, mono]) => (
            <div key={k}><div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: C.textMuted, textTransform: "uppercase", marginBottom: 2 }}>{k}</div><div style={{ fontSize: 12, color: C.text, fontFamily: mono ? "monospace" : "inherit", wordBreak: "break-all" }}>{v}</div></div>
          ))}
        </div>
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
          <SectionLabel text={`Segments (${event.segments.length})`} />
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {event.segments.map((seg, i) => {
              const isCradle = policy && String(resolvePath(seg.body, policy.cradleField)) === policy.cradleValue;
              const isGrave  = policy && String(resolvePath(seg.body, policy.graveField))  === policy.graveValue;
              return (
                <div key={seg.eventId} style={{ border: `1px solid ${isCradle ? C.accent + "55" : isGrave ? C.danger + "55" : C.border}`, borderRadius: 8, overflow: "hidden" }}>
                  <div onClick={() => setOpenSeg(openSeg === i ? null : i)} style={{ padding: "9px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", background: openSeg === i ? C.surfaceAlt : C.surface, userSelect: "none" }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span style={{ width: 20, height: 20, borderRadius: "50%", background: isCradle ? C.accent : isGrave ? C.danger : C.borderStrong, color: "#fff", fontSize: 9, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{i + 1}</span>
                      <div>
                        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                          <span style={{ fontSize: 12, fontFamily: "monospace", color: C.text }}>{String(seg.body.eventType ?? seg.body.status ?? Object.keys(seg.body)[0] ?? "—")}</span>
                          {isCradle && <span style={{ fontSize: 9, fontWeight: 700, color: C.accent, background: C.accentLight, padding: "1px 5px", borderRadius: 3 }}>CRADLE</span>}
                          {isGrave  && <span style={{ fontSize: 9, fontWeight: 700, color: C.danger, background: C.dangerLight, padding: "1px 5px", borderRadius: 3 }}>GRAVE</span>}
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
          </div>
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
  const [body, setBody] = useState('{\n  "eventType": "user.login",\n  "sessionId": "sess-NEW1",\n  "userId": "u099"\n}');
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pol = policies.find(p => p.id === policyId);
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
      <div onClick={e => e.stopPropagation()} style={{ width: 580, background: C.surface, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden" }}>
        <div style={{ padding: "16px 22px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div><div style={{ fontSize: 15, fontWeight: 800 }}>Ingest Event Segment</div><div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>Policy resolves key, cradle, and grave from the body</div></div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.textMuted }}>×</button>
        </div>
        <div style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: 14 }}>
          <FSelect label="Aggregation Policy *" value={policyId} onChange={v => { setPolicyId(v); setResult(null); }} options={policies.map(p => ({ value: p.id, label: `${p.name} — ${p.domain}` }))} />
          {pol && (
            <div style={{ padding: "10px 14px", borderRadius: 8, background: C.surfaceAlt, border: `1px solid ${C.border}`, display: "flex", flexDirection: "column", gap: 6 }}>
              <SectionLabel text="Policy Rules" />
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}><span style={{ fontSize: 10, color: C.textMuted, minWidth: 46 }}>⬡ Key</span><ConditionPill label="KEY" field={`body.${pol.keyField}`} color={C.info} /></div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}><span style={{ fontSize: 10, color: C.textMuted, minWidth: 46 }}>▶ Start</span><ConditionPill label="IF" field={`body.${pol.cradleField}`} value={pol.cradleValue} color={C.accent} /></div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}><span style={{ fontSize: 10, color: C.textMuted, minWidth: 46 }}>■ End</span><ConditionPill label="IF" field={`body.${pol.graveField}`} value={pol.graveValue} color={C.danger} /></div>
            </div>
          )}
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: C.textMuted, textTransform: "uppercase" }}>Event Body JSON *</span>
            <textarea value={body} onChange={e => { setBody(e.target.value); setResult(null); }} rows={7} style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", fontSize: 12, fontFamily: "monospace", color: C.text, background: C.surfaceAlt, outline: "none", resize: "vertical" }} />
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

// ─── Stats Bar ────────────────────────────────────────────────────────────────
function StatsBar({ events, eventsTotal, policies }: { events: EventGroupSummary[]; eventsTotal: number; policies: Policy[] }) {
  const stats = [
    { label: "Event Groups",  value: eventsTotal, color: C.text   },
    { label: "Completed",     value: events.filter(e => e.status === "completed").length,   color: C.accent },
    { label: "In Progress",   value: events.filter(e => e.status === "in_progress").length, color: C.warn   },
    { label: "Policies",      value: policies.length, color: C.purple },
    { label: "Segments",      value: events.reduce((a, e) => a + e.segmentCount, 0), color: C.info },
  ];
  return (
    <div style={{ display: "flex", gap: 1, marginBottom: 20 }}>
      {stats.map(s => (
        <div key={s.label} style={{ flex: 1, background: C.surface, border: `1px solid ${C.border}`, padding: "12px 16px" }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: s.color, fontFamily: "monospace", letterSpacing: "-0.02em" }}>{s.value}</div>
          <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginTop: 2 }}>{s.label}</div>
        </div>
      ))}
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
  const [policies,       setPolicies]    = useState<Policy[]>([]);
  const [events,         setEvents]      = useState<EventGroupSummary[]>([]);
  const [eventsTotal,    setEventsTotal] = useState(0);
  const [totalPages,     setTotalPages]  = useState(1);
  const [loading,        setLoading]     = useState(true);
  const [loadError,      setLoadError]   = useState<string | null>(null);
  const [selected,       setSelected]    = useState<EventGroupDetail | null>(null);
  const [showPolicies,   setShowPolicies]  = useState(false);
  const [showIngest,     setShowIngest]    = useState(false);

  // Tabs
  const [activeTab,      setActiveTab]   = useState<"groups" | "segments">("groups");

  // Flat segments (loaded when segments tab is active)
  const [segments,       setSegments]    = useState<FlatSegment[]>([]);
  const [segsLoading,    setSegsLoading] = useState(false);

  // Column visibility
  const [groupVisible, setGroupVisible] = useState<Set<string>>(new Set(GROUP_COLS.map(c => c.key)));
  const [segVisible,   setSegVisible]   = useState<Set<string>>(new Set(SEG_COLS.map(c => c.key)));
  const [showColMenu,  setShowColMenu]  = useState(false);

  // Column widths
  const [groupWidths, setGroupWidths] = useState<Record<string, number>>(Object.fromEntries(GROUP_COLS.map(c => [c.key, c.defaultWidth])));
  const [segWidths,   setSegWidths]   = useState<Record<string, number>>(Object.fromEntries(SEG_COLS.map(c => [c.key, c.defaultWidth])));

  // Filters
  const [statusFilter, setStatusFilter] = useState<"all" | "in_progress" | "completed">("all");
  const [keyFilter,    setKeyFilter]    = useState("");
  const [policyFilter, setPolicyFilter] = useState("all");
  const [fromFilter,   setFromFilter]   = useState("");
  const [toFilter,     setToFilter]     = useState("");
  const [page,         setPage]         = useState(1);
  const [autoRefresh,  setAutoRefresh]  = useState(false);
  const [dateRange,    setDateRange]    = useState("24h");
  const PER_PAGE = 8;

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
  const loadEvents = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const res = await api.events.list({ status: statusFilter, policyId: policyFilter !== "all" ? policyFilter : undefined, aggregationKey: keyFilter || undefined, from: fromFilter || undefined, to: toFilter || undefined, page, limit: PER_PAGE });
      setEvents(res.data); setEventsTotal(res.total); setTotalPages(res.totalPages);
    } catch (e: any) { setLoadError(e.message ?? "Failed to load events"); }
    finally { setLoading(false); }
  }, [statusFilter, policyFilter, keyFilter, fromFilter, toFilter, page]);

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
    } catch (e: any) { console.error("Failed to load segments:", e); }
    finally { setSegsLoading(false); }
  }, [events]);

  useEffect(() => { loadPolicies(); }, [loadPolicies]);
  useEffect(() => { loadEvents(); }, [loadEvents]);
  useEffect(() => { applyDateRange("24h"); }, []);
  useEffect(() => { setPage(1); }, [statusFilter, policyFilter, keyFilter, fromFilter, toFilter]);
  useEffect(() => { if (!autoRefresh) return; const id = setInterval(loadEvents, 10000); return () => clearInterval(id); }, [autoRefresh, loadEvents]);
  useEffect(() => { if (activeTab === "segments") loadSegments(); }, [activeTab, loadSegments]);

  // ── Detail / CRUD ─────────────────────────────────────────────────────────
  async function openDetail(id: string) {
    try { setSelected(await api.events.get(id)); } catch (e: any) { console.error(e); }
  }
  async function savePolicy(form: PolicyForm) {
    const payload = { name: form.name, domain: form.domain, keyField: form.keyField, cradleField: form.cradleField, cradleValue: form.cradleValue, graveField: form.graveField, graveValue: form.graveValue, description: form.description || undefined };
    if (form.id) await api.policies.update(form.id, payload); else await api.policies.create(payload);
    await loadPolicies();
  }
  async function deletePolicy(id: string) { await api.policies.delete(id); await loadPolicies(); }
  async function handleIngest(input: { policyId: string; body: Record<string, unknown> }) {
    const result = await api.ingest.send(input); await loadEvents(); return result;
  }
  function clearFilters() { setStatusFilter("all"); setPolicyFilter("all"); setKeyFilter(""); setFromFilter(""); setToFilter(""); setDateRange("all"); setPage(1); }

  // ── Active cols for each tab ───────────────────────────────────────────────
  const activeGroupCols = GROUP_COLS.filter(c => c.key.startsWith("_") || groupVisible.has(c.key));
  const activeSegCols   = SEG_COLS.filter(c => c.key.startsWith("_") || segVisible.has(c.key));

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "Georgia, serif", color: C.text }}>
      <style>{`
        @keyframes slideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-thumb { background: ${C.borderStrong}; border-radius: 3px; }
        tbody tr:hover td { background: ${C.surfaceAlt}; }
      `}</style>

      {/* Header */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "0 32px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", height: 56 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: "-0.02em" }}>EventAgg</span>
            <span style={{ fontSize: 11, color: C.textMuted, fontFamily: "monospace" }}>v1.0 · policy-driven</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setAutoRefresh(r => !r)} style={{ padding: "7px 14px", fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: "pointer", fontFamily: "inherit", border: `1px solid ${autoRefresh ? C.accent : C.border}`, background: autoRefresh ? C.accentLight : C.surface, color: autoRefresh ? C.accent : C.textMid, display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: autoRefresh ? C.accent : C.borderStrong, display: "inline-block", animation: autoRefresh ? "pulse 2s infinite" : "none" }} />
              {autoRefresh ? "Live · 10s" : "Auto-refresh"}
            </button>
            <button onClick={() => setShowPolicies(true)} style={{ padding: "7px 14px", fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: "pointer", border: `1px solid ${C.purple}60`, background: C.purpleLight, color: C.purple, fontFamily: "inherit" }}>⚙ Policies ({policies.length})</button>
            <button onClick={() => setShowIngest(true)} style={{ padding: "7px 16px", fontSize: 12, fontWeight: 700, borderRadius: 6, cursor: "pointer", border: "none", background: C.accent, color: "#fff", fontFamily: "inherit" }}>+ Ingest Event</button>
          </div>
        </div>
      </div>

      <div style={{ padding: "28px 32px", maxWidth: 1400, margin: "0 auto" }}>
        <StatsBar events={events} eventsTotal={eventsTotal} policies={policies} />

        {/* Filters */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "14px 18px", marginBottom: 14 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <FSelect label="Status" value={statusFilter} onChange={v => setStatusFilter(v as typeof statusFilter)}
              options={[{ value: "all", label: "All statuses" }, { value: "completed", label: "Completed" }, { value: "in_progress", label: "In Progress" }]} />
            <FSelect label="Policy" value={policyFilter} onChange={setPolicyFilter}
              options={[{ value: "all", label: "All policies" }, ...policies.map(p => ({ value: p.id, label: p.name }))]} />
            <FInput label="Aggregation Key contains" value={keyFilter} onChange={setKeyFilter} placeholder="sess-A1B2 / TRD-001 …" />
            <FSelect label="Date Range" value={dateRange} onChange={applyDateRange}
              options={[{ value: "all", label: "All time" }, { value: "24h", label: "Last 24 hours" }, { value: "7d", label: "Last 7 days" }, { value: "30d", label: "Last 30 days" }, { value: "6m", label: "Last 6 months" }, { value: "custom", label: "Custom range…" }]} />
            {dateRange === "custom" && <>
              <FInput label="From" value={fromFilter.slice(0, 10)} onChange={v => { setFromFilter(v ? `${v}T00:00:00.000Z` : ""); setPage(1); }} placeholder="YYYY-MM-DD" style={{ maxWidth: 140 }} />
              <FInput label="To"   value={toFilter.slice(0, 10)}   onChange={v => { setToFilter(v   ? `${v}T23:59:59.999Z` : ""); setPage(1); }} placeholder="YYYY-MM-DD" style={{ maxWidth: 140 }} />
            </>}
            <Btn label="Clear" onClick={clearFilters} />
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: C.textMuted, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{loading ? "Loading…" : `${eventsTotal} total event groups`}{" · "}<span style={{ fontFamily: "monospace", color: C.accent }}>GET /api/v1/events?status={statusFilter}{keyFilter && `&key=${keyFilter}`}{policyFilter !== "all" && `&policy=${policyFilter}`}{fromFilter && `&from=${fromFilter}`}{toFilter && `&to=${toFilter}`}&page={page}</span></span>
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

          {/* Resize hint */}
          <div style={{ padding: "4px 16px", fontSize: 10, color: C.textMuted, background: C.surfaceAlt, borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M5 8h6M3 5l-2 3 2 3M13 5l2 3-2 3"/></svg>
            Drag column dividers to resize · Use Columns button to show/hide
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
                      <tr key={ev.id} style={{ cursor: "pointer" }} onClick={() => openDetail(ev.id)}>
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
                    {segments.map(seg => (
                      <tr key={seg.eventId} style={{ cursor: "pointer" }} onClick={() => openDetail(seg.groupId)}>
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

        {/* Pagination (groups tab only) */}
        {activeTab === "groups" && totalPages > 1 && (
          <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 14 }}>
            <Btn label="← Prev" onClick={() => setPage(p => Math.max(1, p - 1))} small />
            {Array.from({ length: totalPages }, (_, i) => (
              <button key={i} onClick={() => setPage(i + 1)} style={{ padding: "4px 10px", border: `1px solid ${i + 1 === page ? C.accent : C.border}`, borderRadius: 5, background: i + 1 === page ? C.accentLight : C.surface, cursor: "pointer", color: i + 1 === page ? C.accent : C.text, fontSize: 11, fontWeight: i + 1 === page ? 700 : 400, fontFamily: "inherit" }}>{i + 1}</button>
            ))}
            <Btn label="Next →" onClick={() => setPage(p => Math.min(totalPages, p + 1))} small />
          </div>
        )}

        {/* Legend */}
        <div style={{ display: "flex", gap: 16, marginTop: 20, justifyContent: "center", flexWrap: "wrap" }}>
          {[{ color: C.accent, bg: C.accentLight, label: "completed_events — durable (WAL)" }, { color: C.warn, bg: C.warnLight, label: "in_progress_events — hot" }, { color: C.purple, bg: C.purpleLight, label: "Policy-driven — key, cradle & grave from body" }, { color: C.info, bg: C.infoLight, label: "⬡ Key path resolved from segment body" }].map(({ color, bg, label }) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: C.textMuted }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: bg, border: `1px solid ${color}`, display: "inline-block" }} />
              {label}
            </div>
          ))}
        </div>
      </div>

      {selected && <EventDetail event={selected} policy={policies.find(p => p.id === selected.policyId)} onClose={() => setSelected(null)} />}
      {showPolicies && <PoliciesPanel policies={policies} onSave={savePolicy} onDelete={deletePolicy} onClose={() => setShowPolicies(false)} />}
      {showIngest && <IngestModal policies={policies} onIngest={handleIngest} onClose={() => setShowIngest(false)} />}
    </div>
  );
}
