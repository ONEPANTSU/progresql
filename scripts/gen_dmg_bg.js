#!/usr/bin/env node
/**
 * Generate DMG installer background with ProgreSQL brand gradient.
 * Creates a 660x400 PNG with purple gradient (#6366f1 -> #8b5cf6),
 * a curved arrow, and "ProgreSQL" text.
 * Pure Node.js — no external dependencies.
 */

const fs = require("fs");
const zlib = require("zlib");

const WIDTH = 660,
  HEIGHT = 400;

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

// Build pixel data with gradient
const raw = Buffer.alloc(HEIGHT * (1 + WIDTH * 4));
const c1 = [67, 56, 202]; // #4338ca
const c2 = [99, 102, 241]; // #6366f1
const c3 = [139, 92, 246]; // #8b5cf6

// Pseudo-random dots
let rng = 42;
function nextRng() {
  rng = (rng * 1103515245 + 12345) & 0x7fffffff;
  return rng / 0x7fffffff;
}

const dots = [];
for (let i = 0; i < 60; i++) {
  dots.push({
    x: Math.floor(nextRng() * WIDTH),
    y: Math.floor(nextRng() * HEIGHT),
    a: 30 + Math.floor(nextRng() * 50),
  });
}

for (let y = 0; y < HEIGHT; y++) {
  const rowOff = y * (1 + WIDTH * 4);
  raw[rowOff] = 0;
  for (let x = 0; x < WIDTH; x++) {
    const t = x / WIDTH * 0.6 + y / HEIGHT * 0.4;
    let r, g, b;
    if (t < 0.5) {
      r = lerp(c1[0], c2[0], t * 2);
      g = lerp(c1[1], c2[1], t * 2);
      b = lerp(c1[2], c2[2], t * 2);
    } else {
      r = lerp(c2[0], c3[0], (t - 0.5) * 2);
      g = lerp(c2[1], c3[1], (t - 0.5) * 2);
      b = lerp(c2[2], c3[2], (t - 0.5) * 2);
    }

    for (const d of dots) {
      const dist = Math.sqrt((x - d.x) ** 2 + (y - d.y) ** 2);
      if (dist < 1.5) {
        const da = (d.a * Math.max(0, 1 - dist / 1.5)) / 255;
        r = Math.round(r * (1 - da) + 255 * da);
        g = Math.round(g * (1 - da) + 255 * da);
        b = Math.round(b * (1 - da) + 255 * da);
      }
    }

    const off = rowOff + 1 + x * 4;
    raw[off] = r;
    raw[off + 1] = g;
    raw[off + 2] = b;
    raw[off + 3] = 255;
  }
}

function blendPixel(x, y, r, g, b, a) {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
  const off = y * (1 + WIDTH * 4) + 1 + x * 4;
  const t = a / 255;
  raw[off] = Math.round(raw[off] * (1 - t) + r * t);
  raw[off + 1] = Math.round(raw[off + 1] * (1 - t) + g * t);
  raw[off + 2] = Math.round(raw[off + 2] * (1 - t) + b * t);
}

// Draw curved arrow
const arrowColor = [220, 220, 255];
const cx = 330, cy = 330, rad = 160;
const startA = (200 * Math.PI) / 180;
const endA = (340 * Math.PI) / 180;
const thickness = 3.5;

let lastX, lastY;
for (let i = 0; i <= 200; i++) {
  const angle = startA + (endA - startA) * (i / 200);
  const ax = cx + rad * Math.cos(angle);
  const ay = cy + rad * Math.sin(angle);
  if (i > 0) {
    const dx = ax - lastX,
      dy = ay - lastY;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0) {
      const nx = -dy / len,
        ny = dx / len;
      const minX = Math.max(0, Math.floor(Math.min(lastX, ax) - thickness - 1));
      const maxX = Math.min(WIDTH - 1, Math.ceil(Math.max(lastX, ax) + thickness + 1));
      const minY = Math.max(0, Math.floor(Math.min(lastY, ay) - thickness - 1));
      const maxY = Math.min(HEIGHT - 1, Math.ceil(Math.max(lastY, ay) + thickness + 1));
      const half = thickness / 2;
      for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
          const ppx = px - lastX,
            ppy = py - lastY;
          const along = (ppx * dx + ppy * dy) / len;
          if (along < -half || along > len + half) continue;
          let dist;
          if (along < 0) dist = Math.sqrt(ppx * ppx + ppy * ppy);
          else if (along > len) {
            const qx = px - ax,
              qy = py - ay;
            dist = Math.sqrt(qx * qx + qy * qy);
          } else dist = Math.abs(ppx * nx + ppy * ny);
          if (dist <= half + 0.5) {
            const a = dist <= half - 0.5 ? 180 : Math.round(180 * (half + 0.5 - dist));
            blendPixel(px, py, arrowColor[0], arrowColor[1], arrowColor[2], a);
          }
        }
      }
    }
  }
  lastX = ax;
  lastY = ay;
}

// Arrowhead
const endX = cx + rad * Math.cos(endA);
const endY = cy + rad * Math.sin(endA);
const arrowAngle = endA + (10 * Math.PI) / 180;
const arrowLen = 18;
for (const offset of [150, -150]) {
  const a = arrowAngle + (offset * Math.PI) / 180;
  const tx = endX + arrowLen * Math.cos(a);
  const ty = endY + arrowLen * Math.sin(a);
  for (let i = 0; i < 30; i++) {
    const t = i / 30;
    const px = endX + (tx - endX) * t;
    const py = endY + (ty - endY) * t;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d <= 2)
          blendPixel(
            px + dx,
            py + dy,
            arrowColor[0],
            arrowColor[1],
            arrowColor[2],
            Math.round(180 * Math.max(0, 1 - d / 2)),
          );
      }
  }
}

// Draw "ProgreSQL" text
const glyphs = {
  P: ["####.", "#...#", "####.", "#....", "#...."],
  r: [".....", "#.##.", "##...", "#....", "#...."],
  o: [".....", ".##..", "#..#.", "#..#.", ".##.."],
  g: [".....", ".###.", "#..#.", ".###.", "...#."],
  e: [".....", ".##..", "####.", "#....", ".##.."],
  S: [".###.", "#....", ".##..", "...#.", "###.."],
  Q: [".##..", "#..#.", "#..#.", "#.#..", ".##.#"],
  L: ["#....", "#....", "#....", "#....", "####."],
};
const text = "ProgreSQL";
const scale = 3;
const charW = 6 * scale;
const textW = text.length * charW;
const textX = Math.floor((WIDTH - textW) / 2);
const textY = HEIGHT - 60;

for (let ci = 0; ci < text.length; ci++) {
  const gl = glyphs[text[ci]];
  if (!gl) continue;
  for (let gy = 0; gy < gl.length; gy++) {
    for (let gx = 0; gx < gl[gy].length; gx++) {
      if (gl[gy][gx] === "#") {
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) {
            blendPixel(textX + ci * charW + gx * scale + dx, textY + gy * scale + dy, 255, 255, 255, 200);
          }
      }
    }
  }
}

// Create PNG
const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdrData = Buffer.alloc(13);
ihdrData.writeUInt32BE(WIDTH, 0);
ihdrData.writeUInt32BE(HEIGHT, 4);
ihdrData[8] = 8;
ihdrData[9] = 6; // 8-bit RGBA
const ihdr = chunk("IHDR", ihdrData);
const compressed = zlib.deflateSync(raw, { level: 9 });
const idat = chunk("IDAT", compressed);
const iend = chunk("IEND", Buffer.alloc(0));
const png = Buffer.concat([sig, ihdr, idat, iend]);

const outDir = "frontend/public/assets/dmg";
fs.writeFileSync(outDir + "/background.png", png);
fs.writeFileSync(outDir + "/background@2x.png", png);
console.log("Written: " + outDir + "/background.png (" + png.length + " bytes)");
console.log("Written: " + outDir + "/background@2x.png (" + png.length + " bytes)");
