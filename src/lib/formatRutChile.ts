/**
 * Formato visual RUT chileno: 12.345.678-9 (puntos como separador de miles en el cuerpo).
 * Si no parece un RUT válido, devuelve el string original recortado.
 */
export function formatRutChile(raw: string): string {
  const s = raw.trim();
  if (!s || s === "—") return s;

  const normalized = s.replace(/\./g, "").replace(/-/g, "").replace(/\s/g, "").toUpperCase();
  if (normalized.length < 2) return s;

  const dv = normalized.slice(-1);
  const body = normalized.slice(0, -1);

  if (!/^\d+$/.test(body) || body.length < 7 || body.length > 9) return s;
  if (!/^[\dK]$/.test(dv)) return s;

  const rev = body.split("").reverse().join("");
  const parts: string[] = [];
  for (let i = 0; i < rev.length; i += 3) {
    parts.push(rev.slice(i, i + 3).split("").reverse().join(""));
  }
  return `${parts.reverse().join(".")}-${dv}`;
}

/** Sustituye en texto apariciones tipo 12345678-9 o 12.345.678-9 por la forma con puntos. */
export function formatRutOccurrencesInText(text: string): string {
  return text.replace(/\b(?:\d{1,2}\.\d{3}\.\d{3}|\d{7,9})\s*-\s*([0-9Kk])\b/g, (full) =>
    formatRutChile(full.replace(/\s+/g, "")),
  );
}
