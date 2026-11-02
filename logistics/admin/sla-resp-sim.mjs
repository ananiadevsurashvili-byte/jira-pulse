// Sim of the fixed admSlaApplyNative (wave 4 — unconditional artifact
// handling) with the REAL probed payloads: done rows "– / –" or "0h" resp,
// AND pending rows "0h" resp while the resolution clock is still running.
const TBLISI_OFF = 4 * 3600e3;
function whSpanMs(from, to) {
  from = Number(from); to = Number(to);
  if (!(from > 0) || !(to > from)) return 0;
  const DAY = 864e5, START = 2 * 3600e3, END = 10 * 3600e3;
  let f = (from + TBLISI_OFF) % DAY, t = (to + TBLISI_OFF) % DAY;
  const fd = Math.floor((from + TBLISI_OFF) / DAY), td = Math.floor((to + TBLISI_OFF) / DAY);
  const dow = (d) => (new Date(d * DAY - TBLISI_OFF)).getUTCDay();
  let total = 0;
  for (let d = fd; d <= td && total < 1e15; d++) {
    if (dow(d) === 0 || dow(d) === 6) continue;
    const s = d === fd ? f : START, e = d === td ? t : END;
    if (e > s) total += Math.min(e, END) - Math.max(s, START) < 0 ? 0 : Math.min(e, END) - Math.max(s, START);
  }
  return Math.max(0, total);
}
const ARTIFACT_MS = 60e3;
function mk(a) {
  if (!a || !a.completed) return null;
  let ms = Number(a.elapsedMs) || 0;
  if (ms < ARTIFACT_MS && a.stopMs && a.startMs) {
    const w = whSpanMs(a.startMs, a.stopMs) || (a.stopMs - a.startMs);
    if (w > ms) ms = w;
  }
  return { ms, state: a.breached ? 'out' : 'in' };
}
const RESP_GOAL = 2 * 3600e3;
// minimal fake row so the r.resMs fallback path is exercised like in prod
function makeRow(resMsOverride) {
  return { respMs: 0, respAtMs: 0, respState: 'pending', resMs: resMsOverride || 0,
           resolvedMs: 0, resState: 'pending', elapsedMs: 9 * 3600e3 };
}
function applyNative(sla, r) {
  let resp = mk(sla.resp);
  const res = mk(sla.res);
  const respGoal = RESP_GOAL;
  const respIsArtifact = !!resp && resp.ms < ARTIFACT_MS;
  const resSpan = (res && res.ms) || r.resMs || 0;
  if (resSpan && (!resp || respIsArtifact || resp.ms > resSpan)) {
    const effStart = sla.res?.startMs ?? (sla.resp && sla.resp.startMs);
    const effStop = sla.res?.stopMs ?? (sla.resp && sla.resp.stopMs);
    resp = { ms: resSpan, state: resSpan <= respGoal ? 'in' : 'out' };
    sla.resp = Object.assign({}, sla.resp || {
      startMs: effStart, stopMs: effStop, goalMs: respGoal
    }, { completed: true, breached: resp.state === 'out', elapsedMs: resSpan, startMs: effStart, stopMs: effStop });
  } else if (respIsArtifact && !resSpan) {
    sla.resp = Object.assign({}, sla.resp, { completed: false, elapsedMs: 0 });
    resp = null;
  }
  if (resp) { r.respMs = resp.ms; r.respState = resp.state; r._natResp = true; }
  if (res) {
    r.resMs = res.ms; r.resolvedMs = res.ms; r.resState = res.state; r._natRes = true;
    if ((Number(sla.res.elapsedMs) || 0) !== res.ms) {
      sla.res = Object.assign({}, sla.res, { elapsedMs: res.ms });
    }
  }
  /* chip rendering = what admSlaBadgeCell/admRenderCard show */
  const natResp = sla.resp && sla.resp.completed ? sla.resp : null;
  const natRes = sla.res && sla.res.completed ? sla.res : null;
  const respChip = natResp ? fmt(natResp.elapsedMs)
    : (r.respState !== 'nodata' && r.respAtMs) || r.respState === 'pending' || r.respState === 'overdue'
      ? fmt(r.elapsedMs) + ' /' : '–';
  const resChip = natRes ? fmt(natRes.elapsedMs)
    : r.resState === 'pending' || r.resState === 'overdue' ? fmt(r.elapsedMs) + ' /' : '–';
  return { respState: r.respState, resState: r.resState, respChip, resChip,
           same: r._natResp && r._natRes && r.respMs === r.resMs ? 'EXACT-MATCH' : '' };
}
const fmt = (ms) => {
  if (!(ms > 0)) return '—';
  const h = ms / 3600e3;
  if (h >= 48) return Math.round(ms / 864e5) + 'd';
  const hi = Math.floor(h), mi = Math.round((h - hi) * 60);
  return mi && hi < 8 ? `${hi}h ${mi}m` : `${hi}h`;
};
// ── wave 4 probes (2026-10-31 / 11-01) ──
const cases = [
  // done rows, both cycles completed — Resolution-Set rule must make both fields IDENTICAL
  ['LOG-6468', { resp: { completed: true, elapsedMs: 0,    breached: false, startMs: 1793393985630, stopMs: 1793393987929 },
                 res:  { completed: true, elapsedMs: 0,    breached: false, startMs: 1793393985630, stopMs: 1793395030009 } }, 0],
  ['LOG-6461', { resp: { completed: true, elapsedMs: 0,    breached: false, startMs: 1793388086754, stopMs: 1793388093575 },
                 res:  { completed: true, elapsedMs: 0,    breached: false, startMs: 1793388086754, stopMs: 1793388577259 } }, 0],
  ['LOG-6393', { resp: { completed: true, elapsedMs: 2100, breached: false, startMs: 1793363655886, stopMs: 1793363657986 },
                 res:  { completed: true, elapsedMs: 18826713, breached: false, startMs: 1793363655886, stopMs: 1793382482599 } }, 0],
  ['LOG-6386', { resp: { completed: true, elapsedMs: 2338, breached: false, startMs: 1793361543300, stopMs: 1793361545638 },
                 res:  { completed: true, elapsedMs: 6654025, breached: false, startMs: 1793361543300, stopMs: 1793368197325 } }, 0],
  ['LOG-6388', { resp: { completed: true, elapsedMs: 2110, breached: false, startMs: 1793361846754, stopMs: 1793361848864 },
                 res:  { completed: true, elapsedMs: 6344501, breached: false, startMs: 1793361846754, stopMs: 1793368191255 } }, 0],
  // pending rows — resp sliver, res cycle UNcompleted: live working clock must show, no fake "0h"
  ['LOG-6396', { resp: { completed: true, elapsedMs: 2789, breached: false, startMs: 1793364744384, stopMs: 1793364747173 },
                 res:  { completed: false, elapsedMs: 20859914, breached: false, startMs: 1793364744384, stopMs: 0 } }, 0],
  ['LOG-6395', { resp: { completed: true, elapsedMs: 2091, breached: false, startMs: 1793364661601, stopMs: 1793364663692 },
                 res:  { completed: false, elapsedMs: 20944388, breached: false, startMs: 1793364661601, stopMs: 0 } }, 0],
  ['LOG-6390', { resp: { completed: true, elapsedMs: 2566, breached: false, startMs: 1793362991802, stopMs: 1793362994368 },
                 res:  { completed: false, elapsedMs: 22615506, breached: false, startMs: 1793362991802, stopMs: 0 } }, 0],
  // earlier waves — regression guards
  ['LOG-6237', { resp: { completed: true, elapsedMs: 1886, breached: false, startMs: 1793273758697, stopMs: 1793273760583 },
                 res:  { completed: true, elapsedMs: 36138336, breached: false, startMs: 1793273758697, stopMs: 1793367497033 } }, 0],
  ['LOG-6344', { resp: { completed: true, elapsedMs: 0,    breached: false, startMs: 1793348294730, stopMs: 1793348296904 },
                 res:  { completed: true, elapsedMs: 8493069, breached: false, startMs: 1793348294730, stopMs: 1793362893069 } }, 0],
  // genuine EARLIER first reply (>= 1m, shorter than resolution) must STAY untouched
  ['genuine 30m reply', { resp: { completed: true, elapsedMs: 1800e3, breached: false, startMs: 0, stopMs: 1800e3 },
                          res:  { completed: true, elapsedMs: 10 * 3600e3, breached: false, startMs: 0, stopMs: 10 * 3600e3 } }, 0],
  ['genuine 1h reply', { resp: { completed: true, elapsedMs: 3600e3, breached: false, startMs: 0, stopMs: 3600e3 },
                         res:  { completed: true, elapsedMs: 20 * 3600e3, breached: false, startMs: 0, stopMs: 20 * 3600e3 } }, 0],
];
for (const [k, sla, rowResMs] of cases) {
  const r = makeRow(rowResMs);
  applyNative(sla, r);
  const o = { respState: r.respState, resState: r.resState,
    respChip: (sla.resp && sla.resp.completed ? fmt(sla.resp.elapsedMs)
      : (r.respState === 'pending' || r.respState === 'overdue') ? fmt(r.elapsedMs) + ' /' : '–'),
    resChip: (sla.res && sla.res.completed ? fmt(sla.res.elapsedMs)
      : (r.resState === 'pending' || r.resState === 'overdue') ? fmt(r.elapsedMs) + ' /' : '–') };
  const same = r._natResp && r._natRes && r.respMs === r.resMs ? '  EXACT-MATCH' : '';
  console.log(`${k}: resp=${o.respChip} (${r.respState}) | res=${o.resChip} (${r.resState})${same}`);
}
