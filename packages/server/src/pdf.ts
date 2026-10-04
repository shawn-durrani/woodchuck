// Writes the workshop drawings as a PDF. Each sheet's marks become vector
// lines, shapes and Helvetica text at true size, so the PDF prints sharp at
// 100%. Helvetica is one of the fonts every PDF reader has, so nothing is
// embedded, and text is written in the WinAnsi encoding it comes with.

import { deflateSync } from "node:zlib";
import { textWidth_mm, type Mark, type Paper, type Sheet } from "@woodchuck/core";

/** Points per millimetre. */
const PT = 72 / 25.4;

const n = (v: number) => String(Math.round(v * 1000) / 1000);

// WinAnsi matches Latin-1 from 160 up. These are the others the sheets use.
const WIN_ANSI: Record<string, number> = { "…": 0x85, "–": 0x96, "—": 0x97, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95 };

/** Text as a PDF string in WinAnsi, with anything it can't show as a question mark. */
function pdfString(text: string): string {
  let out = "(";
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    const code = c >= 32 && c <= 126 ? c : c >= 160 && c <= 255 ? c : (WIN_ANSI[ch] ?? 63);
    if (code === 40 || code === 41 || code === 92) out += "\\" + String.fromCharCode(code);
    else if (code > 126) out += "\\" + code.toString(8).padStart(3, "0");
    else out += String.fromCharCode(code);
  }
  return out + ")";
}

function rgb(hex: string): string {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => n(c / 255)).join(" ");
}

/** One sheet's drawing operators, in points with the origin at the bottom left. */
function pageContent(sheet: Sheet): string {
  const H = sheet.height_mm;
  const X = (x: number) => n(x * PT);
  const Y = (y: number) => n((H - y) * PT);
  const ops: string[] = ["1 J 1 j 0 0 0 RG"];
  const pen = (m: { stroke_mm: number; dashed?: boolean }) =>
    `${n(m.stroke_mm * PT)} w ${m.dashed ? `[${n(2 * PT)} ${n(1 * PT)}] 0 d` : "[] 0 d"}`;
  // Colour is set before a path starts, since a path can't change it.
  const paint = (m: { stroke_mm: number; fill?: string }, path: string) => {
    if (m.fill) return `${rgb(m.fill)} rg ${path} ${m.stroke_mm > 0 ? "B" : "f"}`;
    return `${path} S`;
  };
  for (const m of sheet.marks as Mark[]) {
    switch (m.kind) {
      case "line":
        ops.push(`${pen(m)} ${X(m.x1_mm)} ${Y(m.y1_mm)} m ${X(m.x2_mm)} ${Y(m.y2_mm)} l S`);
        break;
      case "shape": {
        const [first, ...rest] = m.points_mm;
        if (!first) break;
        const path = [`${X(first[0])} ${Y(first[1])} m`, ...rest.map((p) => `${X(p[0])} ${Y(p[1])} l`), "h"].join(" ");
        ops.push(`${pen(m)} ${paint(m, path)}`);
        break;
      }
      case "circle": {
        // Four Bézier quarters.
        const k = 0.5523 * m.r_mm;
        const { cx_mm: cx, cy_mm: cy, r_mm: r } = m;
        const c = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => `${X(x1)} ${Y(y1)} ${X(x2)} ${Y(y2)} ${X(x3)} ${Y(y3)} c`;
        const path = [
          `${X(cx + r)} ${Y(cy)} m`,
          c(cx + r, cy + k, cx + k, cy + r, cx, cy + r),
          c(cx - k, cy + r, cx - r, cy + k, cx - r, cy),
          c(cx - r, cy - k, cx - k, cy - r, cx, cy - r),
          c(cx + k, cy - r, cx + r, cy - k, cx + r, cy),
          "h",
        ].join(" ");
        ops.push(`${pen(m)} ${paint(m, path)}`);
        break;
      }
      case "text": {
        const w = textWidth_mm(m.text, m.size_mm, m.bold);
        const shift = m.anchor === "middle" ? -w / 2 : m.anchor === "end" ? -w : 0;
        // Vertical text runs up the page, so the anchor shifts it down.
        const x = m.vertical ? m.x_mm : m.x_mm + shift;
        const y = m.vertical ? m.y_mm - shift : m.y_mm;
        const matrix = m.vertical ? `0 1 -1 0 ${X(x)} ${Y(y)}` : `1 0 0 1 ${X(x)} ${Y(y)}`;
        ops.push(`${rgb(m.colour ?? "#000000")} rg BT /${m.bold ? "F2" : "F1"} ${n(m.size_mm * PT)} Tf ${matrix} Tm ${pdfString(m.text)} Tj ET`);
        break;
      }
    }
  }
  return ops.join("\n");
}

/** The paper a request asks for, when it's one the drawings come on. */
export function paperOf(raw: string | null): { paper?: Paper } {
  return raw === "A4" || raw === "A3" ? { paper: raw } : {};
}

function pdfDate(d: Date): string {
  const p = (v: number) => String(v).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/**
 * The sheets as one PDF, a page each at the sheet's paper size. Viewers
 * that read the hint open the print dialog at actual size.
 */
export function drawingsPdf(sheets: Sheet[], opts: { title: string; now?: Date; compress?: boolean }): Buffer {
  const compress = opts.compress ?? true;
  const chunks: Buffer[] = [];
  let size = 0;
  const write = (b: Buffer | string) => {
    const buf = typeof b === "string" ? Buffer.from(b, "latin1") : b;
    chunks.push(buf);
    size += buf.length;
  };
  const offsets: number[] = [];
  const object = (id: number, body: string, stream?: Buffer) => {
    offsets[id] = size;
    write(`${id} 0 obj\n${body}\n`);
    if (stream) {
      write("stream\n");
      write(stream);
      write("\nendstream\n");
    }
    write("endobj\n");
  };

  // Catalog 1, pages 2, fonts 3 and 4, info 5, then a page and its content per sheet.
  const pageIds = sheets.map((_, i) => 6 + i * 2);
  write("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R /ViewerPreferences << /PrintScaling /None >> >>");
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${sheets.length} >>`);
  object(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  object(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  object(5, `<< /Title ${pdfString(opts.title)} /Producer (Woodchuck) /CreationDate (${pdfDate(opts.now ?? new Date())}) >>`);
  sheets.forEach((sheet, i) => {
    const id = pageIds[i]!;
    const raw = Buffer.from(pageContent(sheet), "latin1");
    const data = compress ? deflateSync(raw) : raw;
    object(
      id,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(sheet.width_mm * PT)} ${n(sheet.height_mm * PT)}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${id + 1} 0 R >>`,
    );
    object(id + 1, `<< /Length ${data.length}${compress ? " /Filter /FlateDecode" : ""} >>`, data);
  });

  const xref = size;
  const count = 6 + sheets.length * 2;
  write(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id++) write(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  write(`trailer\n<< /Size ${count} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}
