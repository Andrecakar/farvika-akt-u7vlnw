// Hittar papperet i varje foto, rakar upp det (perspektivkorrigering) och
// skriver beskurna bilder till material_beskuret (samma mappstruktur som material).
//
//   node tools/beskar.js            beskar allt
//   node tools/beskar.js --debug X  skriv dessutom en kontrollbild (mosaik) till filen X
//
// Hornen kan skrivas over for enskilda bilder i tools/hornpunkter.json:
//   { "1_Forhor/01_Anna.jpg": [[x,y],[x,y],[x,y],[x,y]] }   (andel 0..1 av bilden: vänster-över, höger-över, höger-under, vänster-under)
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const root = path.resolve(__dirname, "..");
const SRC = path.join(root, "material");
const OUT = path.join(root, "material_beskuret");
const OVERRIDES_FILE = path.join(__dirname, "hornpunkter.json");
const EXTS = [".jpg", ".jpeg", ".png", ".bmp"];
const DETECT_W = 600;
const MAX_SIDE = 3600;

function walk(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (EXTS.includes(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

function otsu(g) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < g.length; i++) hist[g[i]]++;
  const total = g.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = t; }
  }
  return thr;
}

// Separabel min/max-filter (erosion/dilation av en binar mask).
function morph(mask, w, h, r, doErode) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  const want = doErode ? 0 : 1; // erosion: ett enda 0 i fonstret ger 0; dilation: ett enda 1 ger 1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = doErode ? 1 : 0;
    for (let k = -r; k <= r; k++) {
      const xx = x + k;
      if (xx < 0 || xx >= w) continue; // utanfor bilden raknas inte (annars "aeter" ramen papperet)
      if (mask[y * w + xx] === want) { v = want; break; }
    }
    tmp[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = doErode ? 1 : 0;
    for (let k = -r; k <= r; k++) {
      const yy = y + k;
      if (yy < 0 || yy >= h) continue;
      if (tmp[yy * w + x] === want) { v = want; break; }
    }
    out[y * w + x] = v;
  }
  return out;
}

// Fyller alla "hal" i masken, dvs. mork yta som inte hanger ihop med bildens kant (t.ex. ett foto mitt pa en sida).
function fillHoles(mask, w, h) {
  const reach = new Uint8Array(w * h);
  const stack = [];
  const push = (p) => { if (!mask[p] && !reach[p]) { reach[p] = 1; stack.push(p); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const p = stack.pop(), x = p % w, y = (p / w) | 0;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = reach[i] ? 0 : 1;
  return out;
}

// Storsta sammanhangande omradet i masken.
function largestComponent(mask, w, h) {
  const label = new Int32Array(w * h);
  let best = { id: 0, size: 0 }, id = 0;
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || label[s]) continue;
    id++; let size = 0;
    stack.push(s); label[s] = id;
    while (stack.length) {
      const p = stack.pop(); size++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = id; stack.push(p - 1); }
      if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && mask[p - w] && !label[p - w]) { label[p - w] = id; stack.push(p - w); }
      if (y < h - 1 && mask[p + w] && !label[p + w]) { label[p + w] = id; stack.push(p + w); }
    }
    if (size > best.size) best = { id, size };
  }
  const out = new Uint8Array(w * h);
  if (best.id) for (let i = 0; i < out.length; i++) if (label[i] === best.id) out[i] = 1;
  return { mask: out, size: best.size };
}

// Returnerar fyra horn som andelar (0..1): TL, TR, BR, BL - eller null.
function detect(rgb, w, h) {
  const g = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = Math.min(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
  const thr = otsu(g);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = g[i] > thr ? 1 : 0;

  // Texten gor hal i det vita: stang igen dem (dilation sedan erosion) innan vi tunnar ut for att skilja papper at.
  const closed = fillHoles(morph(morph(mask, w, h, 9, false), w, h, 9, true), w, h);
  const R = 8;
  const eroded = morph(closed, w, h, R, true);
  const comp = largestComponent(eroded, w, h);
  if (comp.size < w * h * 0.12) return null;
  const grown = morph(comp.mask, w, h, R, false);

  let tl = null, tr = null, br = null, bl = null;
  let sTL = Infinity, sBR = -Infinity, dTR = -Infinity, dBL = Infinity, area = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!grown[y * w + x] || !closed[y * w + x]) continue;
    area++;
    const s = x + y, d = x - y;
    if (s < sTL) { sTL = s; tl = [x, y]; }
    if (s > sBR) { sBR = s; br = [x, y]; }
    if (d > dTR) { dTR = d; tr = [x, y]; }
    if (d < dBL) { dBL = d; bl = [x, y]; }
  }
  if (!tl || !tr || !br || !bl) return null;
  const quad = [tl, tr, br, bl].map(([x, y]) => [x / w, y / h]);
  const a = polyArea(quad);
  if (a < 0.2 || a > 0.995) return null;
  return quad;
}

function polyArea(q) {
  let s = 0;
  for (let i = 0; i < 4; i++) { const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4]; s += x1 * y2 - x2 * y1; }
  return Math.abs(s) / 2;
}

function shrink(quad, f) {
  const cx = quad.reduce((s, p) => s + p[0], 0) / 4, cy = quad.reduce((s, p) => s + p[1], 0) / 4;
  return quad.map(([x, y]) => [x + (cx - x) * f, y + (cy - y) * f]);
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Perspektivkorrigering: avbilda enhetskvadraten (u,v) pa fyrhornet P0..P3 (TL,TR,BR,BL).
function warp(src, W, H, quadFrac) {
  const P = quadFrac.map(([x, y]) => [x * W, y * H]);
  const outW0 = (dist(P[0], P[1]) + dist(P[3], P[2])) / 2;
  const outH0 = (dist(P[0], P[3]) + dist(P[1], P[2])) / 2;
  const k = Math.min(1, MAX_SIDE / Math.max(outW0, outH0));
  const ow = Math.round(outW0 * k), oh = Math.round(outH0 * k);

  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = P;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  let a, b, c, d, e, f, g, hh;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    a = x1 - x0; b = x3 - x0; c = x0; d = y1 - y0; e = y3 - y0; f = y0; g = 0; hh = 0;
  } else {
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    hh = (dx1 * sy - sx * dy1) / den;
    a = x1 - x0 + g * x1; b = x3 - x0 + hh * x3; c = x0;
    d = y1 - y0 + g * y1; e = y3 - y0 + hh * y3; f = y0;
  }

  const out = Buffer.alloc(ow * oh * 3);
  for (let j = 0; j < oh; j++) {
    const v = (j + 0.5) / oh;
    for (let i = 0; i < ow; i++) {
      const u = (i + 0.5) / ow;
      const q = g * u + hh * v + 1;
      let X = (a * u + b * v + c) / q - 0.5, Y = (d * u + e * v + f) / q - 0.5;
      X = Math.min(W - 1.001, Math.max(0, X)); Y = Math.min(H - 1.001, Math.max(0, Y));
      const xi = X | 0, yi = Y | 0, fx = X - xi, fy = Y - yi;
      const p00 = (yi * W + xi) * 3, p10 = p00 + 3, p01 = p00 + W * 3, p11 = p01 + 3;
      const o = (j * ow + i) * 3;
      for (let ch = 0; ch < 3; ch++) {
        out[o + ch] = (src[p00 + ch] * (1 - fx) + src[p10 + ch] * fx) * (1 - fy) + (src[p01 + ch] * (1 - fx) + src[p11 + ch] * fx) * fy;
      }
    }
  }
  return { data: out, width: ow, height: oh };
}

async function main() {
  const debugIdx = process.argv.indexOf("--debug");
  const debugFile = debugIdx > -1 ? process.argv[debugIdx + 1] : null;
  const overrides = fs.existsSync(OVERRIDES_FILE) ? JSON.parse(fs.readFileSync(OVERRIDES_FILE, "utf8")) : {};

  if (!fs.existsSync(SRC)) { console.error("Hittar ingen material-mapp."); process.exit(1); }
  if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const files = walk(SRC).sort();
  const tiles = [];
  for (const file of files) {
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    const dest = path.join(OUT, path.dirname(rel), path.basename(rel, path.extname(rel)) + ".jpg");
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    const small = await sharp(file).rotate().resize({ width: DETECT_W }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let quad = overrides[rel] || null;
    let how = quad ? "manuell" : "auto";
    if (!quad) quad = detect(small.data, small.info.width, small.info.height);
    if (!quad) how = "ingen (originalet behalls)";

    if (quad) {
      const full = await sharp(file).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const use = overrides[rel] ? quad : shrink(quad, 0.01); // lite marginal bort sa att kantskuggor inte foljer med
      const res = warp(full.data, full.info.width, full.info.height, use);
      await sharp(res.data, { raw: { width: res.width, height: res.height, channels: 3 } }).jpeg({ quality: 92 }).toFile(dest);
    } else {
      await sharp(file).rotate().jpeg({ quality: 92 }).toFile(dest);
    }
    console.log(how.padEnd(10), rel);

    if (debugFile) {
      const tw = 300, th = 400;
      const showResult = process.argv.includes("--resultat"); // visa beskuret resultat i stallet for markerat omrade
      const base = await sharp(showResult ? dest : file).rotate().resize({ width: tw, height: th, fit: "contain", background: "#222" }).jpeg().toBuffer();
      let svg = "";
      if (quad && !showResult) {
        // contain-skalning: berakna var bildens yta hamnar i tilen
        const o = { width: small.info.width, height: small.info.height }; // efter EXIF-rotation
        const sc = Math.min(tw / o.width, th / o.height), dw = o.width * sc, dh = o.height * sc, ox = (tw - dw) / 2, oy = (th - dh) / 2;
        const pts = quad.map(([x, y]) => `${(ox + x * dw).toFixed(1)},${(oy + y * dh).toFixed(1)}`).join(" ");
        svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${th}"><polygon points="${pts}" fill="rgba(255,0,0,0.15)" stroke="red" stroke-width="2"/></svg>`;
      }
      const tile = svg ? await sharp(base).composite([{ input: Buffer.from(svg) }]).jpeg().toBuffer() : base;
      tiles.push(tile);
    }
  }

  if (debugFile && tiles.length) {
    const cols = 6, tw = 300, th = 400, rows = Math.ceil(tiles.length / cols);
    await sharp({ create: { width: cols * tw, height: rows * th, channels: 3, background: "#000" } })
      .composite(tiles.map((input, i) => ({ input, left: (i % cols) * tw, top: Math.floor(i / cols) * th })))
      .jpeg({ quality: 80 }).toFile(debugFile);
    console.log("Kontrollbild:", debugFile);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
