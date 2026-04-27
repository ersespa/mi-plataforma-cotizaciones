import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { formatRutChile, formatRutOccurrencesInText } from "@/lib/formatRutChile";

export type CotizacionItemPDF = {
  codigo: string;
  descripcion: string;
  cantidad: number;
  unidad: string;
  precio_unitario: number;
  descuento_pct: number;
};

export type CotizacionPDFInput = {
  empresa: {
    razon_social: string;
    rut: string;
    email: string;
    telefono: string;
    web: string;
  };
  cliente: {
    nombre: string;
    rut: string;
    direccion: string;
    direccion_despacho: string;
    ciudad: string;
    atencion: string;
    contacto: string;
    condicion_pago: string;
  };
  cotizacion: {
    numero: string;
    validez: string;
    moneda: string;
    vendedor: string;
  };
  fecha: string;
  items: CotizacionItemPDF[];
  totals: { subtotal: number; ivaMonto: number; total: number };
  /** Notas / observaciones (mismo bloque que en la pantalla de cotización) */
  notas?: string;
  logoUrl?: string;
};

const DEFAULT_NOTAS_PDF = `Datos Bancarios
Razón Social: ERSE ELECTRIC SPA     RUT: 77.638.085-7
Cta Cte: 88413903     Banco: Santander     Correo: ventas@erse.cl`;

/** Texto pie (PDF). */
const FOOTER_DEVOLUCION_TEXT = "Forma de Pago: Contado, Transferencia Bancaria, Link de pago, Tarjeta de Crédito";

/** Tamaños tipo Veltra (referencia Cotización 919): compactos */
const PT = {
  meta: 9,
  body: 9,
  bodyValue: 9,
  tableHead: 8.5,
  tableBody: 8,
  docBoxRut: 14,
  docBoxTipo: 13,
  docBoxNumero: 12,
  totals: 9,
  sectionBold: 9,
  footer: 8,
} as const;

/** Notas / datos bancarios: texto más compacto que la caja de totales */
const NOTAS_BODY_PT = 7.45;
const NOTAS_LINE_STEP = 4.55;

/** Cabecera tabla ítems: azul marca (Tailwind blue-900 #1c398e, acento “Total” en la app) */
const TABLE_HEAD_BG: [number, number, number] = [28, 57, 142];
const TABLE_HEAD_TEXT: [number, number, number] = [255, 255, 255];

/** Naranja “Electric” del logo ERSE (#FF8000) */
const DOC_BOX_STROKE_ORANGE: [number, number, number] = [255, 128, 0];
const DOC_BOX_LINE_MM = 0.65;

/** Texto interior recuadro: negro como referencia Veltra (segunda imagen) */
const DOC_BOX_TEXT: [number, number, number] = [0, 0, 0];

/** Etiquetas meta + cliente: mismos textos que en `drawLabeledLine` (ancho columna etiqueta negrita) */
const LABELED_LINE_LABELS = [
  "FECHA :",
  "VENCIMIENTO :",
  "CONDICIÓN DE PAGO :",
  "VENDEDOR(a) :",
  "SEÑOR(ES) :",
  "R.U.T. :",
  "DIRECCIÓN DESPACHO :",
  "CIUDAD :",
  "CONTACTO :",
] as const;

function measureLabelColWidthMm(doc: jsPDF): number {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(PT.body);
  let m = 0;
  for (const label of LABELED_LINE_LABELS) {
    m = Math.max(m, doc.getTextWidth(label));
  }
  return m + 0.6;
}

function formatFechaCotizacion(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function rutPdf(value: string | undefined): string {
  const t = (value ?? "").trim();
  if (!t || t === "—") return "—";
  return formatRutChile(t);
}

/** Montos como en referencia Veltra (separador miles, sin prefijo $) */
function formatMontoVeltra(n: number) {
  return new Intl.NumberFormat("es-CL", {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  }).format(Number.isFinite(n) ? Math.round(n) : 0);
}

function lineTotal(it: CotizacionItemPDF) {
  const bruto = it.cantidad * it.precio_unitario;
  const pct = Math.min(100, Math.max(0, it.descuento_pct));
  return Math.round(bruto * (1 - pct / 100));
}

function unitPriceNet(it: CotizacionItemPDF) {
  const pct = Math.min(100, Math.max(0, it.descuento_pct));
  if (pct >= 100) return 0;
  return Math.max(0, Math.round(it.precio_unitario * (1 - pct / 100)));
}

/** Etiquetas a resaltar en negrita dentro de las notas */
const NOTAS_BOLD_LABELS = ["Datos Bancarios", "Razón Social:", "RUT:", "Cta Cte:", "Banco:", "Correo:"] as const;
const NOTAS_BOLD_LABEL_ANYWHERE_RE = new RegExp(`(${NOTAS_BOLD_LABELS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");

function flattenNotasLines(doc: jsPDF, raw: string, maxW: number, fontSize: number): string[] {
  doc.setFont("helvetica", "normal");
  doc.setFontSize(fontSize);
  const out: string[] = [];
  for (const block of raw.split(/\n/)) {
    const t = block.trim();
    if (!t) continue;
    const wrapped = doc.splitTextToSize(t, maxW);
    if (Array.isArray(wrapped)) out.push(...wrapped);
    else out.push(String(wrapped));
  }
  return out;
}

function drawNotasPhysicalLine(doc: jsPDF, line: string, x: number, y: number, fontSize: number) {
  doc.setTextColor(28, 28, 28);
  doc.setFontSize(fontSize);

  let cursorX = x;
  let lastIdx = 0;
  const src = line;
  for (const match of src.matchAll(NOTAS_BOLD_LABEL_ANYWHERE_RE)) {
    const idx = match.index ?? -1;
    if (idx < 0) continue;

    const before = src.slice(lastIdx, idx);
    if (before) {
      doc.setFont("helvetica", "normal");
      doc.text(before, cursorX, y);
      cursorX += doc.getTextWidth(before);
    }

    const label = match[1] ?? "";
    if (label) {
      doc.setFont("helvetica", "bold");
      doc.text(label, cursorX, y);
      cursorX += doc.getTextWidth(label);
    }

    lastIdx = idx + label.length;
  }

  const after = src.slice(lastIdx);
  if (after) {
    doc.setFont("helvetica", "normal");
    doc.text(after, cursorX, y);
  }
}

async function fetchLogoDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(typeof fr.result === "string" ? fr.result : null);
      fr.onerror = () => reject(new Error("read"));
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function measureImageFromDataUrl(dataUrl: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    if (typeof Image === "undefined") {
      reject(new Error("no Image"));
      return;
    }
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error("img"));
    img.src = dataUrl;
  });
}

/**
 * Quita márgenes blancos / transparentes del PNG del logo (canvas solo en navegador).
 * Si falla o no hay `document`, devuelve el mismo data URL.
 */
function trimImageDataUrlWhitespace(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    if (typeof document === "undefined" || typeof Image === "undefined") {
      resolve(dataUrl);
      return;
    }
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (w < 2 || h < 2) {
          resolve(dataUrl);
          return;
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0);
        const { data } = ctx.getImageData(0, 0, w, h);
        const isBg = (i: number) => {
          const a = data[i + 3];
          if (a < 16) return true;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          return r > 247 && g > 247 && b > 247;
        };
        let top = 0;
        let bottom = h - 1;
        let left = 0;
        let right = w - 1;
        outerTop: for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (!isBg((y * w + x) * 4)) {
              top = y;
              break outerTop;
            }
          }
        }
        outerBottom: for (let y = h - 1; y >= top; y--) {
          for (let x = 0; x < w; x++) {
            if (!isBg((y * w + x) * 4)) {
              bottom = y;
              break outerBottom;
            }
          }
        }
        outerLeft: for (let x = 0; x < w; x++) {
          for (let y = top; y <= bottom; y++) {
            if (!isBg((y * w + x) * 4)) {
              left = x;
              break outerLeft;
            }
          }
        }
        outerRight: for (let x = w - 1; x >= left; x--) {
          for (let y = top; y <= bottom; y++) {
            if (!isBg((y * w + x) * 4)) {
              right = x;
              break outerRight;
            }
          }
        }
        const cw = right - left + 1;
        const ch = bottom - top + 1;
        if (cw < 2 || ch < 2 || (left === 0 && top === 0 && right === w - 1 && bottom === h - 1)) {
          resolve(dataUrl);
          return;
        }
        const out = document.createElement("canvas");
        out.width = cw;
        out.height = ch;
        const octx = out.getContext("2d");
        if (!octx) {
          resolve(dataUrl);
          return;
        }
        octx.drawImage(canvas, left, top, cw, ch, 0, 0, cw, ch);
        resolve(out.toDataURL("image/png"));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/** Escala (ancho, alto) mm manteniendo proporción dentro de un tope */
function fitImageMm(srcW: number, srcH: number, maxWmm: number, maxHmm: number): { w: number; h: number } {
  if (srcW <= 0 || srcH <= 0) return { w: maxWmm, h: maxHmm };
  const r = srcW / srcH;
  let w = maxWmm;
  let h = w / r;
  if (h > maxHmm) {
    h = maxHmm;
    w = h * r;
  }
  return { w, h };
}

function drawLabeledLine(
  doc: jsPDF,
  sideX: number,
  maxW: number,
  label: string,
  value: string,
  y: number,
  labelColW: number,
): number {
  const gapAfterLabel = 1.2;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(PT.body);
  doc.text(label, sideX, y, { align: "left" });
  const valueStart = sideX + labelColW + gapAfterLabel;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(PT.bodyValue);
  const text = (value || "").trim() || "—";
  const lines = doc.splitTextToSize(text, Math.max(20, sideX + maxW - valueStart));
  doc.text(lines, valueStart, y);
  const lineCount = Array.isArray(lines) ? lines.length : 1;
  return y + Math.max(4.6, lineCount * 3.9 + 0.35);
}

/**
 * Misma fila Y: cliente (izq., negro) + meta (der., gris).
 * `yNextPaired` = siguiente fila emparejada; `yNextLeft` = bajo solo la columna izquierda (p. ej. CONTACTO).
 */
function drawPairedLabeledRow(
  doc: jsPDF,
  y: number,
  labelColW: number,
  left: { sideX: number; maxW: number; label: string; value: string },
  right: { sideX: number; maxW: number; label: string; value: string },
): { yNextPaired: number; yNextLeft: number } {
  doc.setTextColor(0, 0, 0);
  const yNextLeft = drawLabeledLine(doc, left.sideX, left.maxW, left.label, left.value, y, labelColW);
  doc.setTextColor(40, 40, 40);
  const yR = drawLabeledLine(doc, right.sideX, right.maxW, right.label, right.value, y, labelColW);
  return { yNextPaired: Math.max(yNextLeft, yR), yNextLeft: yNextLeft };
}

type JsPdfWithAutoTable = jsPDF & { lastAutoTable?: { finalY: number } };

/** Solo datos del cliente (sin email de la empresa). Nombre y celular separados por coma. */
function contactoLineaCliente(c: CotizacionPDFInput["cliente"]) {
  const parts = [c.atencion, c.contacto].map((s) => (s || "").trim()).filter(Boolean);
  return parts.join(", ") || "—";
}

const EMPRESA_HEADER_RAZON_PT = 11;
const EMPRESA_HEADER_BODY_PT = 8;
const EMPRESA_HEADER_LINE_RAZON = 4.5;
const EMPRESA_HEADER_LINE_BODY = 3.85;

/** Ancho (mm) de la línea más larga tras `splitTextToSize` a `wrapW` (mismo criterio que el dibujo) */
function measureEmpresaHeaderMaxLineWidthMm(doc: jsPDF, wrapW: number, e: CotizacionPDFInput["empresa"]): number {
  const rows = [
    (e.razon_social || "—").trim(),
    `RUT: ${rutPdf(e.rut)}`,
    `Email: ${e.email || "—"}`,
    `Web: ${e.web || "—"}`,
    `Teléfono / WhatsApp: ${e.telefono || "—"}`,
  ];
  let maxW = 0;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(EMPRESA_HEADER_RAZON_PT);
  for (const line of doc.splitTextToSize(rows[0], wrapW)) {
    maxW = Math.max(maxW, doc.getTextWidth(line));
  }
  doc.setFont("helvetica", "normal");
  doc.setFontSize(EMPRESA_HEADER_BODY_PT);
  for (let i = 1; i < rows.length; i++) {
    for (const line of doc.splitTextToSize(rows[i], wrapW)) {
      maxW = Math.max(maxW, doc.getTextWidth(line));
    }
  }
  return maxW;
}

/** Altura aproximada del bloque empresa (mm) para centrarlo en la banda del encabezado */
function measureEmpresaHeaderBlockHeight(doc: jsPDF, blockW: number, e: CotizacionPDFInput["empresa"]): number {
  const rows = [
    (e.razon_social || "—").trim(),
    `RUT: ${rutPdf(e.rut)}`,
    `Email: ${e.email || "—"}`,
    `Web: ${e.web || "—"}`,
    `Teléfono / WhatsApp: ${e.telefono || "—"}`,
  ];
  let h = 0;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(EMPRESA_HEADER_RAZON_PT);
  h += (doc.splitTextToSize(rows[0], blockW).length || 1) * EMPRESA_HEADER_LINE_RAZON;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(EMPRESA_HEADER_BODY_PT);
  for (let i = 1; i < rows.length; i++) {
    h += (doc.splitTextToSize(rows[i], blockW).length || 1) * EMPRESA_HEADER_LINE_BODY;
  }
  return h;
}

function drawEmpresaHeaderLeft(
  doc: jsPDF,
  leftX: number,
  blockW: number,
  topY: number,
  e: CotizacionPDFInput["empresa"],
) {
  let y = topY;
  doc.setTextColor(25, 25, 25);
  const razon = (e.razon_social || "—").trim();
  doc.setFont("helvetica", "bold");
  doc.setFontSize(EMPRESA_HEADER_RAZON_PT);
  for (const line of doc.splitTextToSize(razon, blockW)) {
    doc.text(line, leftX, y, { align: "left" });
    y += EMPRESA_HEADER_LINE_RAZON;
  }
  doc.setFont("helvetica", "normal");
  doc.setFontSize(EMPRESA_HEADER_BODY_PT);
  const rest: string[] = [
    `RUT: ${rutPdf(e.rut)}`,
    `Email: ${e.email || "—"}`,
    `Web: ${e.web || "—"}`,
    `Teléfono / WhatsApp: ${e.telefono || "—"}`,
  ];
  for (const row of rest) {
    for (const line of doc.splitTextToSize(row, blockW)) {
      doc.text(line, leftX, y, { align: "left" });
      y += EMPRESA_HEADER_LINE_BODY;
    }
  }
  doc.setTextColor(0, 0, 0);
}

/**
 * PDF cotización (hoja **carta** / Letter), cabecera estilo Veltra: logo proporcional,
 * recuadro documento a la derecha misma altura que la banda del logo.
 */
export async function generatePDF(data: CotizacionPDFInput): Promise<void> {
  const margin = 12;
  /** Encabezado un poco más arriba (hoja carta) */
  const headerBandTop = 8;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "letter" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const txtW = pageW - 2 * margin;
  const logoUrl = data.logoUrl ?? "/logo-erse.png";
  const vencimientoTexto = (data.cotizacion.validez ?? "").trim();

  doc.setFont("helvetica", "normal");

  /** Recuadro tipo Veltra (ancho fijo ~ documento referencia) */
  const boxW = 68;
  const gapLogoBox = 5;
  /** Espacio entre el borde derecho del logo (dibujado) y el texto empresa */
  const gapLogoEmpresaMm = 2.8;
  /** Aire lateral dentro de la franja logo–recuadro + centrado del bloque */
  const empresaBandSidePadMm = 4;
  const minCenterBandMm = 50;
  const boxXPreview = pageW - margin - boxW;
  const maxLogoWmm = Math.min(
    88,
    Math.max(36, boxXPreview - margin - 2 * gapLogoBox - minCenterBandMm),
  );
  const maxLogoHmm = 40;
  /** Escala final respecto al tope de caja (tras `fitImageMm`) */
  const LOGO_DISPLAY_SCALE = 0.5;

  let logoDrawW = 0;
  let logoDrawH = 0;
  /** Tamaño logo sin `LOGO_DISPLAY_SCALE`: solo layout (banda, recuadro, franja central) */
  let logoLayoutWmm = 0;
  let logoLayoutHmm = 0;
  let logoDataUrl: string | null = null;
  let logoImageOk = false;

  const fetched = await fetchLogoDataUrl(logoUrl);
  if (fetched) {
    try {
      const trimmed = await trimImageDataUrlWhitespace(fetched);
      const { w: iw, h: ih } = await measureImageFromDataUrl(trimmed);
      const fit = fitImageMm(iw, ih, maxLogoWmm, maxLogoHmm);
      logoLayoutWmm = fit.w;
      logoLayoutHmm = fit.h;
      logoDrawW = fit.w * LOGO_DISPLAY_SCALE;
      logoDrawH = fit.h * LOGO_DISPLAY_SCALE;
      logoDataUrl = trimmed;
      logoImageOk = true;
    } catch {
      logoDataUrl = null;
    }
  }

  const textLogoH = 11;
  const padV = 2;
  const boxX = pageW - margin - boxW;
  const logoX = margin;
  const logoWForLayout = logoImageOk ? logoLayoutWmm : 42;
  const empresaRight = boxX - gapLogoBox;
  const empresaBandLeft = logoImageOk
    ? logoX + logoDrawW + gapLogoEmpresaMm
    : logoX + logoWForLayout + gapLogoBox;
  const empresaBandW = Math.max(28, empresaRight - empresaBandLeft);
  const pad = Math.min(empresaBandSidePadMm, empresaBandW / 6);
  const innerW = Math.max(24, empresaBandW - 2 * pad);
  const maxLineMm = measureEmpresaHeaderMaxLineWidthMm(doc, innerW, data.empresa);
  const empresaLeft = empresaBandLeft + pad + Math.max(0, (innerW - maxLineMm) / 2);
  const empresaW = innerW;
  const empresaBlockH = measureEmpresaHeaderBlockHeight(doc, empresaW, data.empresa);
  const headerRowH = Math.max(
    logoImageOk ? logoLayoutHmm + padV * 2 : Math.max(28, textLogoH + padV * 2),
    empresaBlockH + 4,
  );
  const boxH = headerRowH;
  const boxY = headerBandTop;
  const cx = boxX + boxW / 2;

  /* Bloque empresa: primero su Y para alinear el logo con la 1ª línea (razón social) */
  const yEmpresaStart = headerBandTop + Math.max(0, (headerRowH - empresaBlockH) / 2);
  /** Tras recortar márgenes del logo: baseline 1ª línea → techo visual de mayúsculas 11 pt negrita */
  const fontMmRazon = (EMPRESA_HEADER_RAZON_PT * 25.4) / 72;
  const baselineToCapTopMm = fontMmRazon * 1.12 + 1.05;
  const logoYRaw = yEmpresaStart - baselineToCapTopMm;
  /** Bajar ~1 línea respecto a la razón social (misma escala que el bloque empresa) */
  const logoDropOneLineMm = EMPRESA_HEADER_LINE_RAZON;
  const logoY = logoImageOk ? Math.max(headerBandTop, logoYRaw + logoDropOneLineMm) : yEmpresaStart;

  if (logoImageOk && logoDataUrl) {
    try {
      doc.addImage(logoDataUrl, "PNG", logoX, logoY, logoDrawW, logoDrawH);
    } catch {
      logoImageOk = false;
    }
  }
  /* Sin logo: la razón social sigue en el bloque central (evita duplicar texto a la izquierda) */

  /* Datos de empresa: alineado a la izquierda, centrado en la franja logo–recuadro */
  drawEmpresaHeaderLeft(doc, empresaLeft, empresaW, yEmpresaStart, data.empresa);

  /* Recuadro: borde naranja más grueso; texto arriba / centro / abajo del interior */
  doc.setDrawColor(...DOC_BOX_STROKE_ORANGE);
  doc.setLineWidth(DOC_BOX_LINE_MM);
  doc.rect(boxX, boxY, boxW, boxH);

  const padIn = 5.5;
  /** jsPDF usa baseline: arriba / centro / abajo dentro del recuadro */
  const yRutTop = boxY + padIn + 4.6;
  const yCotizMid = boxY + boxH / 2 + 1.8;
  const yNumBottom = boxY + boxH - padIn - 1;

  doc.setFontSize(PT.docBoxRut);
  doc.setTextColor(...DOC_BOX_TEXT);
  doc.setFont("helvetica", "bold");
  doc.text(`R.U.T.: ${rutPdf(data.empresa.rut)}`, cx, yRutTop, { align: "center" });

  doc.setFont("helvetica", "bold");
  doc.setFontSize(PT.docBoxTipo);
  doc.setTextColor(...DOC_BOX_TEXT);
  doc.text("COTIZACIÓN", cx, yCotizMid, { align: "center" });

  doc.setFont("helvetica", "bold");
  doc.setFontSize(PT.docBoxNumero);
  doc.setTextColor(...DOC_BOX_TEXT);
  const numDoc = data.cotizacion.numero?.trim() || "—";
  doc.text(`Nº ${numDoc}`, cx, yNumBottom, { align: "center" });
  doc.setTextColor(0, 0, 0);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(PT.body);

  const headerBottom = headerBandTop + headerRowH + 5;
  let y = headerBottom + 4.6;

  /* Meta (derecha) + cliente (izquierda): mismas filas — FECHA ∥ SEÑOR(ES), etc. */
  doc.setFontSize(PT.meta);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(PT.body);
  const labelColW = measureLabelColWidthMm(doc);
  const contentRightX = pageW - margin;
  const gapMeta = 1.2;
  /** Ensanchar bloque meta para evitar cortes (p.ej. "Carlos Deocares") */
  const minMetaBlockW = labelColW + gapMeta + 36;
  const metaBlockW = Math.min(txtW, minMetaBlockW);
  const metaSideX = contentRightX - metaBlockW;

  const c = data.cliente;
  let pair = drawPairedLabeledRow(
    doc,
    y,
    labelColW,
    { sideX: margin, maxW: txtW, label: "SEÑOR(ES) :", value: c.nombre || "—" },
    { sideX: metaSideX, maxW: metaBlockW, label: "FECHA :", value: formatFechaCotizacion(data.fecha) },
  );
  y = pair.yNextPaired;
  pair = drawPairedLabeledRow(
    doc,
    y,
    labelColW,
    { sideX: margin, maxW: txtW, label: "R.U.T. :", value: rutPdf(c.rut) },
    { sideX: metaSideX, maxW: metaBlockW, label: "VENCIMIENTO :", value: vencimientoTexto || " " },
  );
  y = pair.yNextPaired;
  pair = drawPairedLabeledRow(
    doc,
    y,
    labelColW,
    {
      sideX: margin,
      maxW: txtW,
      label: "DIRECCIÓN DESPACHO :",
      value: (c.direccion_despacho || "").trim() || "—",
    },
    {
      sideX: metaSideX,
      maxW: metaBlockW,
      label: "CONDICIÓN DE PAGO :",
      value: (data.cliente.condicion_pago || "").trim() || "—",
    },
  );
  y = pair.yNextPaired;
  pair = drawPairedLabeledRow(
    doc,
    y,
    labelColW,
    { sideX: margin, maxW: txtW, label: "CIUDAD :", value: (c.ciudad || "").trim() || "—" },
    { sideX: metaSideX, maxW: metaBlockW, label: "VENDEDOR(a) :", value: data.cotizacion.vendedor || "—" },
  );
  doc.setTextColor(0, 0, 0);
  /** CONTACTO justo bajo CIUDAD (mismo ritmo que el resto del bloque izq.); la tabla sigue bajo la columna más baja (dcha. si VENDEDOR ocupa más líneas). */
  const yAfterContacto = drawLabeledLine(
    doc,
    margin,
    txtW,
    "CONTACTO :",
    contactoLineaCliente(c),
    pair.yNextLeft,
    labelColW,
  );
  y = Math.max(pair.yNextPaired, yAfterContacto) + 3.2;

  const body = data.items.map((it, idx) => [
    String(idx + 1),
    it.codigo || "—",
    it.descripcion || "—",
    String(it.cantidad),
    formatMontoVeltra(unitPriceNet(it)),
    formatMontoVeltra(lineTotal(it)),
  ]);

  /** Caja de totales fija abajo a la derecha: reservar espacio para que la tabla no la tape */
  const totalsBoxW = 76;
  const totalsBoxPad = 5;
  const totalsLineStep = 5.35;
  const totalsLineCount = 3;
  /** Distancia borde superior interior → primera baseline (notas y totales, compacto) */
  const totalsFirstBaselineOffset = 3.05;
  const totalsBoxBottomSlack = 2.85;
  const totalsBoxH =
    totalsBoxPad +
    totalsFirstBaselineOffset +
    (totalsLineCount - 1) * totalsLineStep +
    totalsBoxBottomSlack;

  const footerText = (FOOTER_DEVOLUCION_TEXT || "").trim();
  const footerEnabled = footerText.length > 0;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(PT.footer + 0.5);
  const footerWrapW = pageW - 2 * margin - 10;
  const footerLinesArr = footerEnabled ? doc.splitTextToSize(footerText, footerWrapW) : [];
  const footerLineCount = footerEnabled ? Math.max(1, Array.isArray(footerLinesArr) ? footerLinesArr.length : 1) : 0;
  const footerLineH = 4.05;
  const footerPadY = 3.5;
  const footerBandH = footerEnabled ? footerPadY * 2 + footerLineCount * footerLineH : 0;
  const gapAboveFooter = footerEnabled ? 6 : 0;
  const gapBottomPage = footerBandH + gapAboveFooter;

  /** Espacio para notas + totales + franja pie devolución */
  const tableBottomReserve = totalsBoxH + 58 + footerBandH + gapAboveFooter - 10;

  autoTable(doc, {
    startY: y,
    head: [["#", "CÓDIGO", "DETALLE", "Cantidad", "PRECIO", "TOTAL"]],
    body,
    styles: {
      fontSize: PT.tableBody,
      cellPadding: 1.1,
      textColor: [22, 22, 22],
      lineColor: [188, 188, 188],
      lineWidth: 0.1,
    },
    headStyles: {
      fillColor: TABLE_HEAD_BG,
      textColor: TABLE_HEAD_TEXT,
      fontStyle: "bold",
      fontSize: PT.tableHead,
      halign: "center",
    },
    columnStyles: {
      0: { cellWidth: 9, halign: "center" },
      1: { cellWidth: 24 },
      2: { cellWidth: "auto" },
      3: { cellWidth: 18, halign: "center" },
      4: { cellWidth: 28, halign: "right" },
      5: { cellWidth: 30, halign: "right" },
    },
    margin: { left: margin, right: margin, bottom: tableBottomReserve },
    theme: "grid",
  });

  let yAfterTable = ((doc as JsPdfWithAutoTable).lastAutoTable?.finalY ?? y + 30) + 6;
  if (yAfterTable > pageH - 55) {
    doc.addPage();
    yAfterTable = margin + 4;
  }

  const totalsBoxX = pageW - margin - totalsBoxW;
  const totalsBoxY = pageH - margin - gapBottomPage - totalsBoxH;
  const tLeft = totalsBoxX + totalsBoxPad;
  const tRight = totalsBoxX + totalsBoxW - totalsBoxPad;
  const ty0 = totalsBoxY + totalsBoxPad + totalsFirstBaselineOffset;
  const sepGray: [number, number, number] = [200, 208, 216];
  const fmtPeso = (n: number) => `$${formatMontoVeltra(n)}`;

  /* Altura caja Notas (izquierda, alineada abajo con totales) */
  const notasRaw = formatRutOccurrencesInText((data.notas ?? "").trim() || DEFAULT_NOTAS_PDF);
  const notasGap = 5;
  const notasBoxX = margin;
  const maxNotasAvailW = totalsBoxX - margin - notasGap;
  /** Ancho completo hasta la columna de totales (como antes) */
  const notasBoxW = Math.max(40, maxNotasAvailW);
  const notasMaxW = notasBoxW - 2 * totalsBoxPad;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(NOTAS_BODY_PT);
  const notasBodyLines = flattenNotasLines(doc, notasRaw, notasMaxW, NOTAS_BODY_PT);
  const linesForDraw = notasBodyLines.length > 0 ? notasBodyLines : ["—"];
  const nNotasBody = linesForDraw.length;
  /** Altura al texto: entre líneas va (n−1)·paso; antes sobraba ~una línea + padding inferior duplicado */
  const notasBoxBottomSlack = 2.85;
  const notasBoxH =
    totalsBoxPad +
    totalsFirstBaselineOffset +
    Math.max(0, nNotasBody - 1) * NOTAS_LINE_STEP +
    notasBoxBottomSlack;
  const notasBottom = totalsBoxY + totalsBoxH;
  const notasBoxY = notasBottom - notasBoxH;

  const cardRx = 2.2;
  const notasLeft = notasBoxX + totalsBoxPad;
  /** Título fuera del cuadro, encima, negro */
  const gapLabelAboveBox = 2.6;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(PT.sectionBold);
  doc.setTextColor(0, 0, 0);
  const yNotasLabel = notasBoxY - gapLabelAboveBox;
  doc.text("Notas / Observaciones", notasLeft, yNotasLabel);

  /* Cuerpo: mismo estilo que la caja de totales (blanco, borde gris, esquinas redondeadas) */
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(...sepGray);
  doc.setLineWidth(0.35);
  doc.roundedRect(notasBoxX, notasBoxY, notasBoxW, notasBoxH, cardRx, cardRx, "FD");

  let yNotasLine = notasBoxY + totalsBoxPad + totalsFirstBaselineOffset;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(NOTAS_BODY_PT);
  doc.setTextColor(28, 28, 28);
  for (const line of linesForDraw) {
    drawNotasPhysicalLine(doc, line, notasLeft, yNotasLine, NOTAS_BODY_PT);
    yNotasLine += NOTAS_LINE_STEP;
  }

  /* Caja totales: fondo blanco y borde redondeado (sin líneas internas que crucen el texto) */
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(...sepGray);
  doc.setLineWidth(0.35);
  doc.roundedRect(totalsBoxX, totalsBoxY, totalsBoxW, totalsBoxH, cardRx, cardRx, "FD");

  doc.setTextColor(28, 28, 28);
  doc.setFontSize(PT.totals);
  doc.setFont("helvetica", "normal");
  doc.text("Subtotal:", tLeft, ty0);
  doc.setFont("helvetica", "bold");
  doc.text(fmtPeso(data.totals.subtotal), tRight, ty0, { align: "right" });

  const ty1 = ty0 + totalsLineStep;
  doc.setFont("helvetica", "normal");
  doc.text("IVA (19%):", tLeft, ty1);
  doc.setFont("helvetica", "bold");
  doc.text(fmtPeso(data.totals.ivaMonto), tRight, ty1, { align: "right" });

  const ty2 = ty0 + 2 * totalsLineStep;
  doc.setFontSize(PT.totals + 0.8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(28, 28, 28);
  doc.text("Total:", tLeft, ty2);
  doc.text(fmtPeso(data.totals.total), tRight, ty2, { align: "right" });

  doc.setTextColor(0, 0, 0);

  if (footerEnabled) {
    /* Pie devolución: fondo blanco, borde gris, letras negras (misma línea que notas/totales) */
    const footerY0 = pageH - margin - footerBandH;
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(...sepGray);
    doc.setLineWidth(0.35);
    doc.roundedRect(margin, footerY0, pageW - 2 * margin, footerBandH, cardRx, cardRx, "FD");
    doc.setTextColor(0, 0, 0);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(PT.footer + 0.5);
    const footerLinesDraw = Array.isArray(footerLinesArr) ? footerLinesArr : [String(footerLinesArr)];
    let fy = footerY0 + footerPadY + 3.25;
    const cxPage = pageW / 2;
    for (const fl of footerLinesDraw) {
      doc.text(fl, cxPage, fy, { align: "center" });
      fy += footerLineH;
    }
    doc.setTextColor(0, 0, 0);
    doc.setFont("helvetica", "normal");
  }

  const safeNum = (data.cotizacion.numero || "").replace(/\W/g, "") || "borrador";
  const safeCliente =
    (data.cliente.nombre || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "") || "sin_cliente";

  doc.save(`Cotizacion_${safeNum}_${safeCliente}.pdf`);
}
