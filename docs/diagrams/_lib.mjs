/**
 * Shared drawing primitives for the masqueradarr README diagrams.
 * Palette + type scale are lifted straight from `src/styles.css` so the docs
 * and the SPA stay in visual lockstep.
 */

export const C = {
  // surfaces (--mq-*)
  bg: '#0C0F11',       // --mq-obsidian
  carbon: '#13181A',
  slate: '#1A2124',
  card: '#171D20',     // between carbon + slate
  steel: '#232B2F',
  bracket: '#2A3236',
  lane: '#0F1416',
  // ink
  dim: '#5E696E',      // --mq-dim
  ash: '#9AA5AA',      // --mq-ash
  mist: '#E9EDEE',     // --mq-mist
  // signal
  teal: '#48D7FE',     // --mq-teal
  tealDeep: '#1FAEDB',
  amber: '#F7B83D',    // --warn
  green: '#5FD37F',    // --good
  risk: '#E0564B',     // --mq-risk
};

export const F_SANS = "'Space Grotesk','Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";
export const F_MONO = "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

const ARROW_COLORS = { teal: C.teal, amber: C.amber, green: C.green, risk: C.risk, dim: C.dim, ash: C.ash, mist: C.mist };

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n = (v) => Math.round(v * 100) / 100;

/** Rough advance-width estimate; padding everywhere is generous enough to absorb the error. */
export function measure(str, size, mono = false) {
  return String(str).length * size * (mono ? 0.6 : 0.55);
}

export function text(x, y, s, { fill = C.ash, size = 10.4, weight = 400, anchor = 'start', mono = false, ls = 0, opacity = 1 } = {}) {
  const f = mono ? F_MONO : F_SANS;
  return `<text x="${n(x)}" y="${n(y)}" font-family="${f}" font-size="${size}" font-weight="${weight}" fill="${fill}"`
    + `${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}${ls ? ` letter-spacing="${ls}"` : ''}`
    + `${opacity !== 1 ? ` opacity="${opacity}"` : ''}>${esc(s)}</text>`;
}

/** Orthogonal polyline with rounded corners. */
export function polyPath(pts, r = 9) {
  let d = `M ${n(pts[0][0])} ${n(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1], [cx, cy] = pts[i], [nx, ny] = pts[i + 1];
    const v1 = [cx - px, cy - py], v2 = [nx - cx, ny - cy];
    const l1 = Math.hypot(...v1) || 1, l2 = Math.hypot(...v2) || 1;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    d += ` L ${n(cx - (v1[0] / l1) * rr)} ${n(cy - (v1[1] / l1) * rr)}`;
    d += ` Q ${n(cx)} ${n(cy)} ${n(cx + (v2[0] / l2) * rr)} ${n(cy + (v2[1] / l2) * rr)}`;
  }
  const e = pts[pts.length - 1];
  return `${d} L ${n(e[0])} ${n(e[1])}`;
}

export function edge(pts, { color = 'dim', dash = 0, width = 1.5, head = 'end', r = 9 } = {}) {
  const stroke = ARROW_COLORS[color] || color;
  const key = Object.keys(ARROW_COLORS).find((k) => ARROW_COLORS[k] === stroke) || 'dim';
  const marker = (head === 'end' || head === 'both') ? ` marker-end="url(#a-${key})"` : '';
  const back = (head === 'start' || head === 'both') ? ` marker-start="url(#b-${key})"` : '';
  return `<path d="${polyPath(pts, r)}" fill="none" stroke="${stroke}" stroke-width="${width}"`
    + `${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-linecap="round"${marker}${back} opacity="${dash ? 0.75 : 0.9}"/>`;
}

/** Opaque label that sits on top of an edge so the line never runs through the type. */
export function pill(cx, cy, label, { color = C.ash, size = 9.6, mono = true, fill = C.bg } = {}) {
  const lines = Array.isArray(label) ? label : [label];
  const w = Math.max(...lines.map((l) => measure(l, size, mono))) + 18;
  const h = 8 + lines.length * (size + 4);
  let out = `<rect x="${n(cx - w / 2)}" y="${n(cy - h / 2)}" width="${n(w)}" height="${n(h)}" rx="${n(h / 2)}" fill="${fill}" stroke="${C.bracket}" stroke-width="1"/>`;
  const top = cy - h / 2 + 8 + size * 0.35;
  lines.forEach((l, i) => { out += text(cx, top + i * (size + 4), l, { fill: color, size, mono, anchor: 'middle' }); });
  return out;
}

const T_SIZE = 12.6, S_SIZE = 10.2, S_LH = 14.4, PAD = 13, BADGE_H = 16;

export function cardHeight({ sub = [], badges = [], badgeRows = 1 }) {
  let h = PAD + 14;
  if (sub.length) h += 3 + sub.length * S_LH;
  if (badges.length) h += 9 + badgeRows * (BADGE_H + 4) - 4;
  return h + PAD - 1;
}

function badgeRow(x, y, badges, color) {
  let cx = x, out = '';
  for (const b of badges) {
    const w = measure(b, 8.4, true) + 15;
    out += `<rect x="${n(cx)}" y="${n(y)}" width="${n(w)}" height="${BADGE_H}" rx="5" fill="${color}" fill-opacity="0.11" stroke="${color}" stroke-opacity="0.36" stroke-width="1"/>`
      + text(cx + w / 2, y + 11.2, b, { fill: color, size: 8.4, mono: true, anchor: 'middle', ls: 0.3 });
    cx += w + 6;
  }
  return out;
}

/**
 * The one node primitive every diagram uses: left accent rail, title, meta lines,
 * optional badge chips.
 */
export function card({ x, y, w, title, titleMono = false, titleRight, sub = [], subMono = false, rail = C.dim, badges = [], minH, fill = C.card, titleColor = C.mist, dashed = false }) {
  const h = Math.max(cardHeight({ sub, badges }), minH || 0);
  const tx = x + 18;
  let out = `<g>`
    + `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="9" fill="${fill}" stroke="${C.bracket}" stroke-width="1"${dashed ? ' stroke-dasharray="4 3"' : ''}/>`
    + `<rect x="${n(x + 1.5)}" y="${n(y + 9)}" width="3" height="${n(h - 18)}" rx="1.5" fill="${rail}"/>`;
  out += text(tx, y + PAD + 10.4, title, { fill: titleColor, size: T_SIZE, weight: 600, mono: titleMono, ls: titleMono ? 0 : 0.1 });
  if (titleRight) out += text(x + w - 14, y + PAD + 10.2, titleRight, { fill: C.ash, size: 9.8, anchor: 'end' });
  let cy = y + PAD + 14 + 3;
  for (const s of sub) { cy += S_LH; out += text(tx, cy - 3.5, s, { fill: C.ash, size: S_SIZE, mono: subMono }); }
  if (badges.length) out += badgeRow(tx, cy + 6, badges, rail);
  return { svg: out + `</g>`, h, cx: x + w / 2, cy: y + h / 2, bottom: y + h, right: x + w };
}

/** Dashed container with a fieldset-style legend chip riding the top border. */
export function lane({ x, y, w, h, label, color = C.dim, fill = C.lane }) {
  // label is uppercase + letter-spaced, so the generic sans estimate under-measures it
  const lw = label.length * (9 * 0.64 + 1.3) + 22;
  return `<g>`
    + `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="12" fill="${fill}" stroke="${C.steel}" stroke-width="1" stroke-dasharray="5 4"/>`
    + `<rect x="${n(x + 16)}" y="${n(y - 8)}" width="${n(lw)}" height="16" rx="5" fill="${C.bg}" stroke="${C.bracket}" stroke-width="1"/>`
    + text(x + 16 + lw / 2, y + 3.4, label, { fill: color, size: 9, weight: 600, anchor: 'middle', ls: 1.3 })
    + `</g>`;
}

export function diamond(cx, cy, w, h, label, { color = C.teal } = {}) {
  const pts = `${n(cx)},${n(cy - h / 2)} ${n(cx + w / 2)},${n(cy)} ${n(cx)},${n(cy + h / 2)} ${n(cx - w / 2)},${n(cy)}`;
  return `<g><polygon points="${pts}" fill="${C.card}" stroke="${color}" stroke-opacity="0.5" stroke-width="1.2"/>`
    + text(cx, cy + 3.8, label, { fill: C.mist, size: 10.8, weight: 600, anchor: 'middle' }) + `</g>`;
}

/** Numbered step marker used by the composition funnel. */
export function step(cx, cy, num, color = C.teal) {
  return `<g><circle cx="${n(cx)}" cy="${n(cy)}" r="10" fill="${C.bg}" stroke="${color}" stroke-opacity="0.55" stroke-width="1.2"/>`
    + text(cx, cy + 3.5, num, { fill: color, size: 10, weight: 600, anchor: 'middle', mono: true }) + `</g>`;
}

export function header(w, title, subtitle) {
  return `<g><rect x="32" y="30" width="3" height="18" rx="1.5" fill="${C.teal}"/>`
    + text(45, 44, title, { fill: C.mist, size: 14, weight: 600, ls: 0.2 })
    + (subtitle ? text(w - 32, 44, subtitle, { fill: C.dim, size: 9.8, mono: true, anchor: 'end' }) : '')
    + `<line x1="32" y1="60" x2="${w - 32}" y2="60" stroke="${C.steel}" stroke-width="1"/></g>`;
}

export function legend(x, y, items) {
  let cx = x, out = '';
  for (const [color, label] of items) {
    out += `<circle cx="${n(cx + 4)}" cy="${n(y - 3)}" r="4" fill="${color}"/>`
      + text(cx + 14, y, label, { fill: C.dim, size: 9.6 });
    cx += 14 + measure(label, 9.6) + 22;
  }
  return out;
}

export function svg(w, h, body) {
  const markers = Object.entries(ARROW_COLORS).map(([k, v]) =>
    `<marker id="a-${k}" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">`
    + `<path d="M0.5,0.8 L8.4,4.5 L0.5,8.2 L2.4,4.5 Z" fill="${v}"/></marker>`
    + `<marker id="b-${k}" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" refX="1" refY="4.5" orient="auto">`
    + `<path d="M8.5,0.8 L0.6,4.5 L8.5,8.2 L6.6,4.5 Z" fill="${v}"/></marker>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">
<defs>${markers}
<pattern id="grid" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.8" fill="${C.slate}"/></pattern>
</defs>
<rect x="0" y="0" width="${w}" height="${h}" rx="14" fill="${C.bg}"/>
<rect x="0" y="0" width="${w}" height="${h}" rx="14" fill="url(#grid)" opacity="0.5"/>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="13.5" fill="none" stroke="${C.slate}" stroke-width="1"/>
${body}
</svg>`;
}
