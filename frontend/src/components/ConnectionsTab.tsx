import React, { useState, useEffect } from 'react';

interface Slot { slot_id: number; status: string; subscribed: number; capacity: number; }
interface WsData {
  total_subscribed: number;
  total_capacity: number;
  capacity_per_connection: number;
  max_connections: number;
  slots: Slot[];
  groups: { total: number; active: number };
}
interface Usage { [instrument: string]: number; }

interface HealthStat { count: number; avg_ms: number | null; p95_ms: number | null; last_ms: number | null; }
interface AppHealth {
  overall: string;
  grades: { analytics: string; broadcast: string; queue: string; freshness: string };
  stocks_tracked: number;
  queue_depth: number;
  market_open: boolean;
  last_tier2_snapshot_at: number | null;
  last_tier2_snapshot_age_sec: number | null;
  analytics_tier2: HealthStat;
  broadcast_tier2: HealthStat;
  snapshot_cycle_tier2: HealthStat;
}

const OVERALL_META: Record<string, { label: string; cls: string }> = {
  ok: { label: 'Healthy', cls: 'bg-terminal-pe/20 text-terminal-pe' },
  warning: { label: 'Warning', cls: 'bg-terminal-atm/20 text-terminal-atm' },
  degraded: { label: 'Degraded', cls: 'bg-terminal-ce/20 text-terminal-ce' },
  idle: { label: 'Idle', cls: 'bg-terminal-border/40 text-terminal-muted' },
};
const dotCls = (g?: string) =>
  g === 'ok' ? 'bg-terminal-pe' : g === 'warning' ? 'bg-terminal-atm' : g === 'degraded' ? 'bg-terminal-ce' : 'bg-terminal-border';
const fmtMs = (v: number | null) => (v == null ? '—' : `${Math.round(v)} ms`);

const HealthRow: React.FC<{ label: string; stat?: HealthStat; grade?: string; extra?: string }> = ({ label, stat, grade, extra }) => (
  <div className="flex items-center justify-between gap-3 py-1.5 border-t border-terminal-border/40 first:border-t-0">
    <span className="flex items-center gap-2">
      {grade && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotCls(grade)}`} />}
      <span className="st-label" style={{ fontSize: 12.5 }}>{label}</span>
    </span>
    <span className="st-num text-right" style={{ fontSize: 12 }}>
      {extra ?? (stat && stat.count > 0 ? `avg ${fmtMs(stat.avg_ms)} · p95 ${fmtMs(stat.p95_ms)} · ${stat.count}` : '—')}
    </span>
  </div>
);

const barColor = (pct: number) =>
  pct >= 90 ? 'bg-terminal-ce' : pct >= 70 ? 'bg-terminal-atm' : 'bg-terminal-pe';

const statusPill = (st: string) => {
  if (st === 'open') return <span className="st-pill bg-terminal-pe/20 text-terminal-pe">Open</span>;
  if (st === 'connecting') return <span className="st-pill bg-terminal-atm/20 text-terminal-atm">Connecting</span>;
  return <span className="st-pill bg-terminal-ce/20 text-terminal-ce">{st}</span>;
};

export const ConnectionsTab: React.FC = () => {
  const [ws, setWs] = useState<WsData | null>(null);
  const [usage, setUsage] = useState<Usage>({});
  const [health, setHealth] = useState<AppHealth | null>(null);
  const [tick, setTick] = useState('');

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [r, rh] = await Promise.all([fetch('/api/ws/usage'), fetch('/api/app-health')]);
        if (!r.ok || !alive) return;
        const d = await r.json();
        setWs(d.ws);
        setUsage(d.usage_by_instrument || {});
        if (rh.ok) setHealth(await rh.json());
        setTick(new Date().toLocaleTimeString('en-IN'));
      } catch {}
    };
    load();
    const t = setInterval(load, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!ws) {
    return <div className="st-helper py-8 text-center">Live streaming unavailable — nothing to monitor.</div>;
  }

  const totalPct = ws.total_capacity ? Math.round((ws.total_subscribed / ws.total_capacity) * 100) : 0;
  const openSlots = ws.slots.filter((s) => s.status === 'open').length;
  const inst = Object.entries(usage).sort((a, b) => b[1] - a[1]);
  const maxInst = inst.length ? inst[0][1] : 1;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h3 className="st-section">Connections</h3>
        <span className="st-live flex items-center gap-1.5 text-terminal-pe">
          <span className="w-1.5 h-1.5 rounded-full bg-terminal-pe animate-pulse" /> live
        </span>
      </div>
      <p className="st-helper mb-5">
        Per-socket capacity is an Angel One plan limit and stays in .env (read-only).
      </p>

      {/* Total */}
      <div className="mb-6">
        <div className="flex items-baseline justify-between mb-1.5">
          <span className="st-label">Total utilization — {openSlots} of {ws.max_connections} connections open</span>
          <span>
            <span className="st-value">{ws.total_subscribed.toLocaleString()}</span>
            <span className="st-value-sub"> / {ws.total_capacity.toLocaleString()}</span>
            <span className="st-num ml-2">({totalPct}%)</span>
          </span>
        </div>
        <div className="h-2.5 bg-terminal-border/40 rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all ${barColor(totalPct)}`} style={{ width: `${Math.min(100, totalPct)}%` }} />
        </div>
      </div>

      {/* Slots */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 mb-6">
        {ws.slots.map((s) => {
          const p = Math.round((s.subscribed / s.capacity) * 100);
          return (
            <div key={s.slot_id} className="border border-terminal-border rounded-lg p-3.5">
              <div className="flex items-center justify-between mb-2.5">
                <span className="st-card-title">Connection {s.slot_id}</span>
                {statusPill(s.status)}
              </div>
              <div className="mb-2">
                <span className="st-value">{s.subscribed.toLocaleString()}</span>
                <span className="st-value-sub"> / {s.capacity}</span>
              </div>
              <div className="h-1.5 bg-terminal-border/40 rounded-full overflow-hidden">
                <div className={`h-full rounded-full transition-all ${barColor(p)}`} style={{ width: `${p}%` }} />
              </div>
              <div className="st-helper mt-2" style={{ fontSize: 11.5 }}>{p}% capacity</div>
            </div>
          );
        })}
        {ws.slots.length === 0 && (
          <div className="border border-terminal-border rounded-lg p-3.5 st-helper">No connections yet</div>
        )}
      </div>

      {/* Per-instrument usage */}
      <div className="border border-terminal-border rounded-lg p-4">
        <div className="st-card-title mb-3">Tokens by instrument</div>
        {inst.map(([name, n]) => (
          <div key={name} className="grid grid-cols-[120px_1fr_56px] gap-3 items-center py-1.5">
            <span className="st-sym" style={{ fontSize: 12.5 }}>{name}</span>
            <span className="h-1.5 bg-terminal-border/40 rounded-full overflow-hidden">
              <span className="block h-full bg-terminal-atm rounded-full transition-all" style={{ width: `${Math.round((n / maxInst) * 100)}%` }} />
            </span>
            <span className="st-num text-right">{n}</span>
          </div>
        ))}
        {inst.length === 0 && <div className="st-helper">No active tokens</div>}
      </div>

      {/* App health — application pipeline, not PC resources */}
      {health && (
        <div className="border border-terminal-border rounded-lg p-4 mt-5">
          <div className="flex items-center justify-between mb-1">
            <div className="st-card-title">App health</div>
            <span className={`st-pill ${OVERALL_META[health.overall]?.cls}`}>{OVERALL_META[health.overall]?.label}</span>
          </div>
          <p className="st-helper mb-3" style={{ fontSize: 11.5 }}>
            Whether the app is keeping up with the stocks it tracks — not CPU/RAM.
          </p>
          <HealthRow label="Tier-2 analytics cycle" stat={health.analytics_tier2} grade={health.grades?.analytics} />
          <HealthRow label="Broadcast processing" stat={health.broadcast_tier2} grade={health.grades?.broadcast} />
          <HealthRow label="Snapshot cycle" stat={health.snapshot_cycle_tier2} />
          <HealthRow
            label="Last Tier-2 update"
            grade={health.grades?.freshness}
            extra={
              health.last_tier2_snapshot_at
                ? `${new Date(health.last_tier2_snapshot_at * 1000).toLocaleTimeString('en-IN')} · ${health.last_tier2_snapshot_age_sec}s ago`
                : health.market_open
                ? '—'
                : 'market closed'
            }
          />
          <HealthRow label="DB write queue" grade={health.grades?.queue} extra={`${health.queue_depth} pending`} />
          <HealthRow
            label="Underlying feed age"
            grade={health.grades?.underlying}
            extra={
              health.max_spot_age_sec != null && health.market_open
                ? `${health.max_spot_age_sec}s${health.oldest_feed ? ` (${health.oldest_feed})` : ''}`
                : 'market closed'
            }
          />
          <HealthRow label="Stocks tracked" extra={`${health.stocks_tracked}`} />
        </div>
      )}

      <div className="st-helper mt-3" style={{ fontSize: 11.5, color: 'var(--st-dim)' }}>
        Groups: {ws.groups.active}/{ws.groups.total} active · updated {tick}
      </div>
    </div>
  );
};
