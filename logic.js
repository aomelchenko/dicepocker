// DicePocker game logic. No Owlbear dependencies, so it can be tested in Node.
export const MAX_LOG = 100;       // max rolls kept per player
export const LOG_BUDGET = 2400;   // max JSON characters per player (room metadata is capped at 16 kB in total)
export const MAX_DICE = 20;
export const MAX_REROLLS = 10;

const secureD6 = () => {
  const b = new Uint8Array(1);
  do crypto.getRandomValues(b); while (b[0] >= 252); // reject 252-255 to avoid modulo bias
  return (b[0] % 6) + 1;
};
export const rollDice = (n, rng = secureD6) => Array.from({ length: n }, () => rng());
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.trunc(Number(v)) || 0));

// A roll: { t, lim, x, y, stale: [...], steps: [{ frozen: [...], active: [...] }, ...] }
// stale  = locked from the start, never re-rollable
// frozen = dice kept (not picked) during earlier re-rolls, permanent
// active = the last rolled group; the only dice eligible for the next re-roll
export function newRoll({ stale, pool, lim, x = 0, y = 0, now = Date.now(), rng }) {
  stale = clamp(stale, 0, MAX_DICE);
  pool = clamp(pool, 0, MAX_DICE);
  lim = pool ? clamp(lim, 0, MAX_REROLLS) : 0;
  if (stale + pool < 1) throw new Error("Roll at least one die.");
  return {
    t: Math.floor(now / 1000), lim, x: Math.round(x), y: Math.round(y),
    stale: rollDice(stale, rng),
    steps: [{ frozen: [], active: rollDice(pool, rng) }],
  };
}
export const current = (e) => e.steps[e.steps.length - 1];
export const rerollsLeft = (e) => e.lim - (e.steps.length - 1);
export const fullResult = (e) => current(e).frozen.concat(current(e).active);

export function reroll(e, picked, rng) {
  const cur = current(e);
  const idx = [...new Set(picked)].filter((i) => Number.isInteger(i) && i >= 0 && i < cur.active.length);
  if (!idx.length) throw new Error("Pick at least one die.");
  if (rerollsLeft(e) < 1) throw new Error("No re-rolls left.");
  const frozen = cur.frozen.concat(cur.active.filter((_, i) => !idx.includes(i)));
  return { ...e, steps: [...e.steps, { frozen, active: rollDice(idx.length, rng) }] };
}

// Compact string form, because room metadata is small.
// "time36~limit~x~y~stale~frozen.active~frozen.active..."
const digits = (a) => a.join("");
const parse = (s) => [...(s || "")].map(Number);
export const encode = (e) =>
  [e.t.toString(36), e.lim, e.x, e.y, digits(e.stale),
   ...e.steps.map((s) => digits(s.frozen) + "." + digits(s.active))].join("~");
export function decode(str) {
  const [t, lim, x, y, stale, ...steps] = String(str).split("~");
  if (!steps.length) return null;
  const e = {
    t: parseInt(t, 36), lim: +lim, x: +x, y: +y, stale: parse(stale),
    steps: steps.map((s) => { const [f, a] = s.split("."); return { frozen: parse(f), active: parse(a) }; }),
  };
  return [e.t, e.lim, e.x, e.y].every(Number.isFinite) ? e : null;
}

// Newest first. Drops the oldest rolls until the list fits the count and size limits.
export function trimLog(list, max = MAX_LOG, budget = LOG_BUDGET) {
  const out = list.slice(0, max);
  while (out.length > 1 && JSON.stringify(out).length > budget) out.pop();
  return out;
}

// Table layout in scene units, relative to the group's top-left corner.
// Row 1: stale dice. Next row: frozen dice, a gap, then the active dice.
export function layout(e, size, cols = 10) {
  const step = size * 1.2;
  const cells = [];
  let row = 0;
  const flow = (items) => {
    let col = 0;
    for (const it of items) {
      if (it.gap && col > 0) col += 0.5;
      if (col >= cols) { col = 0; row++; }
      cells.push({ v: it.v, kind: it.kind, x: col * step, y: row * step });
      col++;
    }
    if (items.length) row++;
  };
  const cur = current(e);
  flow(e.stale.map((v) => ({ v, kind: "stale" })));
  flow([
    ...cur.frozen.map((v) => ({ v, kind: "frozen" })),
    ...cur.active.map((v, i) => ({ v, kind: "active", gap: i === 0 })),
  ]);
  const width = Math.max(...cells.map((c) => c.x)) + size;
  const height = Math.max(...cells.map((c) => c.y)) + size;
  return { cells, width, height };
}

// GM-moved dice groups. The new centre lives in a separate GM-owned record, { playerKey: [rollTime, x, y] },
// so moving never competes with a player's own saves. It only applies while it matches that player's current roll.
export const withMoved = (e, o) => (e && Array.isArray(o) && o[0] === e.t ? { ...e, x: o[1], y: o[2] } : e);
export const inside = (p, b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
// Keeps only the positions whose roll is still the player's current one. rollTimes: { playerKey: t }
export function prunePositions(pos, rollTimes) {
  const out = {};
  for (const [k, o] of Object.entries(pos || {})) if (Array.isArray(o) && rollTimes[k] === o[0]) out[k] = o;
  return out;
}
