/*
 * Rebuilds every icon in this directory, plus client/favicon.svg and
 * client/favicon.ico. Run with: node client/icons/regenerate.js
 * Reads nothing; writes only inside client/icons/ and the two favicons.
 *
 * ESM, like client/data/regenerate.js, because package.json declares
 * "type": "module" and a .js file here is loaded as a module.
 *
 * ---------------------------------------------------------------------------
 * Why a rasteriser lives in this repo
 *
 * The alternative was committing five PNGs nobody could re-derive. This project
 * has no build step and no image dependency, and adding sharp or canvas to
 * devDependencies to produce five files that change roughly never is a worse
 * trade than eighty lines of arithmetic. Everything below is node's own zlib
 * and nothing else, so the icons can be re-cut from the palette in
 * client/tokens.css by anybody with node installed.
 *
 * The mark is the board's own string-line: a spine with three dots offset by
 * how late each bus is -- early left, on time center, late right. It is drawn
 * from the board's own colors, which is why it reads as this board and not as
 * a generic bus: the three adherence hexes (--adh-early, --adh-ontime,
 * --adh-late) plus --surface and --hairline, all quoted from tokens.css, and
 * one derived value -- `spine` -- that is no token at all. See PALETTE below,
 * which says which is which. tests/node/client-installable.test.mjs checks the
 * five quoted hexes still match tokens.css, so a repalette cannot leave the
 * home screen showing the old colors, and also asserts that every committed
 * icon is byte-for-byte what this script draws.
 *
 * Antialiasing is 4x supersampling and a box downsample. Nothing here needs
 * scanline coverage: the shapes are a rounded rectangle and three circles.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(DIR, '..');
const REPO = path.resolve(CLIENT, '..');

/* ---- the palette, quoted from client/tokens.css --------------------------- */
export const PALETTE = {
  surface: '#0b0d12',      /* --surface       the tile ground        */
  hairline: '#1e242e',     /* --hairline      the tile's own edge    */
  spine: '#39445a',        /* the ladder spine: --hairline one step up so it
                              survives a 32px favicon, where --hairline itself
                              disappears into the ground */
  early: '#3b82f6',        /* --adh-early     runs left of the spine */
  ontime: '#22c55e',       /* --adh-ontime    on the spine           */
  late: '#f59e0b',         /* --adh-late      runs right of it       */
};

/* ---- a very small rasteriser ---------------------------------------------- */

const SS = 4; /* supersampling factor */

function hex(s) {
  return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
}

/** An RGBA surface, transparent to begin with. All drawing is fully opaque. */
function surface(n) {
  return { n, px: new Uint8Array(n * n * 4) };
}

function put(buf, x, y, rgb) {
  if (x < 0 || y < 0 || x >= buf.n || y >= buf.n) return;
  const i = (y * buf.n + x) * 4;
  buf.px[i] = rgb[0];
  buf.px[i + 1] = rgb[1];
  buf.px[i + 2] = rgb[2];
  buf.px[i + 3] = 255;
}

/** Rounded rectangle, in pixels. r is clamped to half the shorter side. */
function roundRect(buf, x, y, w, h, r, color) {
  const rgb = hex(color);
  const rad = Math.min(r, w / 2, h / 2);
  for (let py = Math.floor(y); py < Math.ceil(y + h); py++) {
    for (let px = Math.floor(x); px < Math.ceil(x + w); px++) {
      /* Sample the pixel center. At SS=4 that is 16 samples per output pixel. */
      const cx = px + 0.5;
      const cy = py + 0.5;
      if (cx < x || cy < y || cx > x + w || cy > y + h) continue;
      /* Distance from the nearest corner center, but only inside a corner box. */
      const nx = Math.min(Math.max(cx, x + rad), x + w - rad);
      const ny = Math.min(Math.max(cy, y + rad), y + h - rad);
      const dx = cx - nx;
      const dy = cy - ny;
      if (dx * dx + dy * dy > rad * rad) continue;
      put(buf, px, py, rgb);
    }
  }
}

function circle(buf, cx, cy, r, color) {
  const rgb = hex(color);
  for (let py = Math.floor(cy - r); py <= Math.ceil(cy + r); py++) {
    for (let px = Math.floor(cx - r); px <= Math.ceil(cx + r); px++) {
      const dx = px + 0.5 - cx;
      const dy = py + 0.5 - cy;
      if (dx * dx + dy * dy <= r * r) put(buf, px, py, rgb);
    }
  }
}

/**
 * Box-downsample by SS. Averaged in PREMULTIPLIED alpha: averaging straight RGB
 * across an edge where half the samples are transparent black would drag the
 * edge pixels toward black and leave a dark halo on the rounded corners.
 */
function downsample(big, n) {
  const out = surface(n);
  const area = SS * SS;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * big.n + (x * SS + sx)) * 4;
          const al = big.px[i + 3] / 255;
          r += big.px[i] * al;
          g += big.px[i + 1] * al;
          b += big.px[i + 2] * al;
          a += al;
        }
      }
      const am = a / area;
      const j = (y * n + x) * 4;
      out.px[j] = am > 0 ? Math.round(r / area / am) : 0;
      out.px[j + 1] = am > 0 ? Math.round(g / area / am) : 0;
      out.px[j + 2] = am > 0 ? Math.round(b / area / am) : 0;
      out.px[j + 3] = Math.round(am * 255);
    }
  }
  return out;
}

/* ---- PNG ------------------------------------------------------------------ */



function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  /* node's own, rather than a table here: same polynomial, and one less
     hand-rolled thing in a file whose point is having no dependencies.
     Added in node 20.15, which is why engines asks for that. */
  crc.writeUInt32BE(zlib.crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 8-bit RGBA, non-interlaced. Sub filter on every row: these images are long
    horizontal runs of one color and Sub costs nothing to compute. */
/*
 * PNG, indexed where it can be and RGBA where it cannot.
 *
 * These are flat fills cut from a six-entry palette, antialiased: every icon
 * lands between 61 and 103 distinct colors, so one index byte per pixel does
 * the work of four RGBA bytes and the file halves -- 23,692 bytes across the
 * five icons down to 10,810, losslessly. Three of them are fully opaque and
 * were carrying an alpha channel that said 255 everywhere. That saving matters
 * here for one specific reason: the worker precaches these, and the icons are
 * the only part of the shell the HTTP cache cannot hand over on a first visit
 * (max-age=86400 rather than must-revalidate), so they are most of what the
 * install still transfers.
 *
 * Filter 0 (None) for indexed, not 1 (Sub). Sub on index bytes takes deltas
 * between palette POSITIONS, which are arbitrary numbers -- it destroys the
 * runs deflate would otherwise find. Filter 1 stays for RGBA, where
 * neighbouring pixels really are numerically close.
 *
 * The RGBA path is kept and is not dead: the >256-color fallback is what makes
 * this safe to leave in place if the mark ever gains a gradient.
 */
export function encodePng(buf) {
  const n = buf.n;
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8; /* bit depth: one byte per sample, or per index */

  /* Palette by first appearance, bailing out the moment it cannot fit. */
  const index = new Map();
  const order = [];
  const idx = new Uint8Array(n * n);
  let indexable = true;
  for (let i = 0; i < n * n && indexable; i++) {
    const o = i * 4;
    const key = (buf.px[o] << 24) | (buf.px[o + 1] << 16) | (buf.px[o + 2] << 8) | buf.px[o + 3];
    let at = index.get(key);
    if (at === undefined) {
      if (order.length === 256) { indexable = false; break; }
      at = order.length;
      index.set(key, at);
      order.push([buf.px[o], buf.px[o + 1], buf.px[o + 2], buf.px[o + 3]]);
    }
    idx[i] = at;
  }

  if (indexable) {
    const raw = Buffer.alloc((n + 1) * n);
    for (let y = 0; y < n; y++) {
      const o = y * (n + 1);
      raw[o] = 0; /* filter: None */
      for (let x = 0; x < n; x++) raw[o + 1 + x] = idx[y * n + x];
    }
    ihdr[9] = 3; /* color type: indexed */
    const plte = Buffer.alloc(order.length * 3);
    for (let i = 0; i < order.length; i++) {
      plte[i * 3] = order[i][0];
      plte[i * 3 + 1] = order[i][1];
      plte[i * 3 + 2] = order[i][2];
    }
    const parts = [magic, chunk('IHDR', ihdr), chunk('PLTE', plte)];
    /* tRNS only when something is actually transparent: an all-255 alpha table
       is bytes spent saying nothing, and three of these five are opaque. */
    if (order.some((c) => c[3] !== 255)) {
      const trns = Buffer.alloc(order.length);
      for (let i = 0; i < order.length; i++) trns[i] = order[i][3];
      parts.push(chunk('tRNS', trns));
    }
    parts.push(chunk('IDAT', zlib.deflateSync(raw, { level: 9 })));
    parts.push(chunk('IEND', Buffer.alloc(0)));
    return Buffer.concat(parts);
  }

  const stride = n * 4;
  const raw = Buffer.alloc((stride + 1) * n);
  for (let y = 0; y < n; y++) {
    const o = y * (stride + 1);
    raw[o] = 1; /* filter: Sub */
    for (let x = 0; x < stride; x++) {
      const v = buf.px[y * stride + x];
      const left = x >= 4 ? buf.px[y * stride + x - 4] : 0;
      raw[o + 1 + x] = (v - left) & 0xff;
    }
  }
  ihdr[9] = 6; /* color type: RGBA */
  return Buffer.concat([
    magic,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A single-image .ico wrapping a PNG. Windows has taken PNG payloads since Vista. */
export function encodeIco(png, size) {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0);           /* reserved */
  head.writeUInt16LE(1, 2);           /* type: icon */
  head.writeUInt16LE(1, 4);           /* one image */
  head[6] = size === 256 ? 0 : size;  /* 0 means 256 in this byte */
  head[7] = size === 256 ? 0 : size;
  head[8] = 0;                        /* palette size: not paletted */
  head[9] = 0;                        /* reserved */
  head.writeUInt16LE(1, 10);          /* color planes */
  /* 32 even though the payload is now an indexed PNG. For a PNG-compressed
     entry these directory fields are informational -- every reader since Vista
     takes the dimensions and format from the embedded PNG's own IHDR -- and 32
     is what every PNG-in-ICO writer puts here. Verified: the payload decodes
     pixel-identical to the RGBA version it replaced. */
  head.writeUInt16LE(32, 12);         /* bits per pixel */
  head.writeUInt32LE(png.length, 14);
  head.writeUInt32LE(22, 18);         /* offset of the payload */
  return Buffer.concat([head, png]);
}

/* ---- the mark -------------------------------------------------------------- */

/*
 * Geometry in a unit square, so every size is the same drawing. The three dots
 * sit at a quarter, a half and three quarters of the spine, offset by the
 * lateness each color stands for. Their bounding box is 0.64 x 0.80, whose
 * diagonal is 1.02 -- which is what sets the maskable scale below.
 */
const DOTS = [
  { y: 0.25, dx: -0.190, color: 'early' },
  { y: 0.50, dx: +0.195, color: 'late' },
  { y: 0.75, dx: +0.020, color: 'ontime' },
];
const DOT_R = 0.115;
const SPINE_W = 0.045;
const SPINE_TOP = 0.13;
const SPINE_BOTTOM = 0.87;

/** Draw the mark into the centered box of side `scale` (a fraction of the canvas). */
function mark(buf, scale) {
  const n = buf.n;
  const s = n * scale;
  const ox = (n - s) / 2;
  const oy = (n - s) / 2;
  const X = (u) => ox + u * s;
  const Y = (v) => oy + v * s;

  roundRect(
    buf,
    X(0.5 - SPINE_W / 2), Y(SPINE_TOP),
    SPINE_W * s, (SPINE_BOTTOM - SPINE_TOP) * s,
    (SPINE_W / 2) * s,
    PALETTE.spine,
  );
  for (const d of DOTS) circle(buf, X(0.5 + d.dx), Y(d.y), DOT_R * s, PALETTE[d.color]);
}

/**
 * One icon.
 *
 *   any       a rounded tile with a hairline edge, for browser UI and for the
 *             launchers that do not mask.
 *   maskable  full bleed, mark shrunk into the 80%-diameter safe circle Android
 *             is allowed to crop to. 0.62 leaves room: the mark's diagonal is
 *             1.02 of its own box, so 0.62 lands at 0.63 of the canvas.
 *   apple     full bleed and fully opaque, because iOS composites onto black
 *             and applies its own corner radius. A pre-rounded source shows a
 *             dark rim inside the system's own curve.
 */
export function render(size, kind) {
  const big = surface(size * SS);
  const n = big.n;
  if (kind === 'any') {
    roundRect(big, 0, 0, n, n, n * 0.20, PALETTE.hairline);
    const inset = Math.max(1, Math.round(n * 0.016));
    roundRect(big, inset, inset, n - inset * 2, n - inset * 2, n * 0.20 - inset, PALETTE.surface);
    mark(big, 0.68);
  } else {
    roundRect(big, 0, 0, n, n, 0, PALETTE.surface);
    mark(big, kind === 'maskable' ? 0.62 : 0.72);
  }
  return downsample(big, size);
}

/* ---- the SVG favicon ------------------------------------------------------- */

/*
 * Written from the same constants rather than drawn by hand, so the vector and
 * the rasters cannot drift. It carries no rounded tile: a tab favicon is shown
 * at 16 CSS pixels and the ground reads better full bleed at that size.
 */
export function favicon() {
  const pct = (u) => +(u * 100).toFixed(2);
  const dots = DOTS.map(
    (d) => `  <circle cx="${pct(0.5 + d.dx)}" cy="${pct(d.y)}" r="${pct(DOT_R)}" fill="${PALETTE[d.color]}"/>`,
  ).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="Dillo Bus Board">
  <title>Dillo Bus Board</title>
  <rect width="100" height="100" rx="20" fill="${PALETTE.surface}"/>
  <rect x="${pct(0.5 - SPINE_W / 2)}" y="${pct(SPINE_TOP)}" width="${pct(SPINE_W)}" height="${pct(SPINE_BOTTOM - SPINE_TOP)}" rx="${pct(SPINE_W / 2)}" fill="${PALETTE.spine}"/>
${dots}
</svg>
`;
}

/* ---- what gets written ----------------------------------------------------- */

export const ICONS = [
  { file: 'icon-192.png', size: 192, kind: 'any' },
  { file: 'icon-512.png', size: 512, kind: 'any' },
  { file: 'maskable-192.png', size: 192, kind: 'maskable' },
  { file: 'maskable-512.png', size: 512, kind: 'maskable' },
  /* iOS ignores the manifest's icons entirely and reads <link rel="apple-touch-icon">.
     180 is the largest size it asks for (iPhone at 3x). */
  { file: 'apple-touch-icon.png', size: 180, kind: 'apple' },
];

/* Only when run directly. tests/node/client-installable.test.mjs imports
   render(), encodePng() and ICONS and compares their output against the
   committed files rather than rewriting them, so the bytes in the repo cannot
   drift from this script without a test failing. That is what the three
   exports are for. */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  for (const icon of ICONS) {
    const png = encodePng(render(icon.size, icon.kind));
    const dest = path.join(DIR, icon.file);
    fs.writeFileSync(dest, png);
    console.log(`wrote ${path.relative(REPO, dest)} (${png.length} bytes)`);
  }

  const svg = path.join(CLIENT, 'favicon.svg');
  fs.writeFileSync(svg, favicon());
  console.log(`wrote ${path.relative(REPO, svg)}`);

  /* 32px, which is what a browser asking for /favicon.ico with no <link> wants. */
  const ico = path.join(CLIENT, 'favicon.ico');
  const icoBytes = encodeIco(encodePng(render(32, 'any')), 32);
  fs.writeFileSync(ico, icoBytes);
  console.log(`wrote ${path.relative(REPO, ico)} (${icoBytes.length} bytes)`);
}
