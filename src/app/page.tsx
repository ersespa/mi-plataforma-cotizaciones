"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { formatRutChile } from "@/lib/formatRutChile";
import { generatePDF } from "@/lib/generatePDF";
import { getSupabaseClient } from "@/lib/supabaseClient";

type QuoteItem = {
  codigo: string;
  descripcion: string;
  cantidad: number;
  unidad: string;
  precio_unitario: number;
  plazo_entrega: string;
  descuento_pct: number;
};

type ProductoSugerencia = {
  codigo: string;
  descripcion: string;
  precioLista: number;
  unidad: string;
};

type ProductoLookupState = "idle" | "loading" | "found" | "not_found" | "error" | "sugerencias";

type ClienteSugerencia = {
  rut: string;
  nombre: string;
  direccion: string;
  direccion_despacho: string;
  ciudad: string;
  atencion: string;
  contacto: string;
  condicion_pago: string;
};

type ClienteListaBusqueda =
  | null
  | {
      campo: "rut" | "nombre" | "atencion";
      estado: ProductoLookupState;
      sugerencias: ClienteSugerencia[];
    };

const DEFAULT_ITEM_PLAZO_ENTREGA = "1 dia hábil";
const DEFAULT_VALIDEZ = "2 días hábiles";
const DEFAULT_NOTAS = `Datos Bancarios
Razón Social: ERSE ELECTRIC SPA     RUT: 77.638.085-7
Cta Cte: 88413903     Banco: Santander     Correo: ventas@erse.cl`;

/** Texto pie (pantalla). */
const FOOTER_DEVOLUCION_TEXT = "Forma de Pago: Contado, Transferencia Bancaria, Link de pago, Tarjeta de Crédito";
const P_UNITARIO_LABEL = "P. Unitario";

const MIN_BUSQUEDA_CLIENTE_LISTA = 3;
const MAX_FILAS_CANDIDATAS_CLIENTE = 350;
const MAX_SUGERENCIAS_CLIENTE = 25;
const DEBOUNCE_CLIENTE_MS = 550;

/**
 * Columnas de la tabla `clientes` usadas en `.ilike()` (deben ser TEXT/VARCHAR en Postgres).
 * Si tu esquema difiere, edita solo estas listas con los nombres exactos de Table Editor.
 * No uses `ilike` sobre integer/numeric (PostgREST responde 400).
 */
const CLIENTES_ILIKE_COLUMNS: Record<"rut" | "nombre" | "atencion", readonly string[]> = {
  rut: ["RUT", "rut"],
  /** Nombre / empresa: columna con espacio y tilde en Postgres (`"Razón Social"`). */
  nombre: ["Razón Social"],
  atencion: ["ATENCION", "atencion", "persona_atencion", "nombre_atencion", "contacto"],
};

function normalizeRut(input: string) {
  return input
    .trim()
    .toUpperCase()
    .replaceAll(".", "")
    .replaceAll("-", "");
}

function formatCLP(value: number) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatMiles(value: number) {
  return new Intl.NumberFormat("es-CL", {
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function parseMilesEntero(raw: string) {
  const digitsOnly = raw.replace(/[^\d]/g, "");
  const n = parseInt(digitsOnly || "0", 10);
  return Number.isFinite(n) ? n : 0;
}

/** Precio unitario mostrado: neto tras % descuento (CLP entero). */
function precioUnitarioEfectivo(precioLista: number, descuentoPct: number) {
  const p = Math.min(100, Math.max(0, descuentoPct));
  if (p >= 100) return 0;
  return Math.max(0, Math.round(precioLista * (1 - p / 100)));
}

/** A partir del unitario neto tipeado, obtiene precio de lista para guardar en ítem. */
function precioListaDesdeEfectivo(precioEfectivo: number, descuentoPct: number) {
  const p = Math.min(100, Math.max(0, descuentoPct));
  if (p >= 100) return 0;
  const f = 1 - p / 100;
  return Math.max(0, Math.round(precioEfectivo / f));
}

function toNumber(value: string) {
  const normalized = value.replaceAll(".", "").replaceAll(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

function parsePriceCLP(raw: unknown) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  if (typeof raw !== "string") return 0;
  // Ej: "$46.910" -> 46910
  const digitsOnly = raw.replace(/[^\d]/g, "");
  const n = parseInt(digitsOnly || "0", 10);
  return Number.isFinite(n) ? n : 0;
}

function pickFirst(obj: unknown, keys: string[]) {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}

/** Quita caracteres que rompen el patrón ILIKE. */
function sanitizeIlikeFragment(s: string) {
  return s.replace(/\\/g, "").replace(/%/g, "").replace(/_/g, "").trim();
}

/** Palabras / fragmentos separados por espacio, coma o punto y coma. */
function tokenizeBusquedaDesc(q: string): string[] {
  return q
    .split(/[\s,;]+/)
    .map((t) => sanitizeIlikeFragment(t))
    .filter((t) => t.length > 0);
}

function foldBusquedaTexto(s: string) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function rowToClienteSugerencia(row: Record<string, unknown>): ClienteSugerencia | null {
  const buscarDato = (palabrasClave: string[]) => {
    const key = Object.keys(row).find((k) =>
      palabrasClave.some((p) => k.toLowerCase().includes(p.toLowerCase())),
    );
    const v = key ? row[key] : "";
    return v === null || v === undefined ? "" : String(v);
  };

  const rut = String(pickFirst(row, ["RUT", "rut", "Rut"]) ?? "");
  const rutTrim = rut.trim();

  const nombreEmpresa = String(
    pickFirst(row, [
      "Razón Social",
      "NOMBRE",
      "nombre",
      "cliente_nombre",
      "razon_social",
      "nombre_fantasia",
      "empresa",
    ]) ??
      buscarDato(["nombre", "razon", "razón", "social", "empresa"]),
  );
  const direccion = String(
    pickFirst(row, ["direccion", "direccion_despacho", "dirección", "dirección_despacho"]) ??
      buscarDato(["direccion", "dirección", "despacho", "dir"]),
  );
  const condicionPago = buscarDato(["condicion", "condición", "pago"]);
  const ciudad = (row["ciudad"] ?? row["Ciudad"] ?? row["CIUDAD"]) != null
    ? String(row["ciudad"] ?? row["Ciudad"] ?? row["CIUDAD"])
    : buscarDato(["ciudad", "comuna"]);
  const contacto = (row["contacto"] ?? row["Contacto"] ?? row["CONTACTO"]) != null
    ? String(row["contacto"] ?? row["Contacto"] ?? row["CONTACTO"])
    : buscarDato(["contacto", "persona"]);
  const personaAtencion = String(
    pickFirst(row, ["atencion", "persona_atencion", "nombre_atencion", "contacto"]) ??
      buscarDato(["persona", "atencion", "atención"]),
  );
  const direccionDespacho = String(
    pickFirst(row, ["direccion_despacho", "dirección_despacho"]) ?? buscarDato(["despacho"]),
  );

  if (!nombreEmpresa.trim() && !rutTrim) return null;

  return {
    rut: rutTrim,
    nombre: nombreEmpresa.trim(),
    direccion: (direccionDespacho || direccion).trim(),
    direccion_despacho: direccionDespacho.trim(),
    ciudad: ciudad.trim(),
    atencion: personaAtencion,
    contacto,
    condicion_pago: condicionPago,
  };
}

function dedupeClienteSugerencias(list: ClienteSugerencia[]): ClienteSugerencia[] {
  const seen = new Set<string>();
  const out: ClienteSugerencia[] = [];
  for (const s of list) {
    const k = normalizeRut(s.rut) || `n:${s.nombre.toLowerCase().slice(0, 120)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function clienteSugerenciaMatcheaTokens(s: ClienteSugerencia, tokens: string[]) {
  const hay = foldBusquedaTexto(
    `${s.rut} ${s.nombre} ${s.direccion} ${s.direccion_despacho} ${s.ciudad} ${s.contacto} ${s.atencion} ${s.condicion_pago}`,
  );
  return tokens.every((t) => hay.includes(foldBusquedaTexto(t)));
}

export default function Home() {
  const [darkMode, setDarkMode] = useState(false);

  // Inicializa según preferencia del sistema y aplica la clase
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const initial = mq?.matches ?? false;
    setDarkMode(initial);
    if (initial) document.documentElement.classList.add("dark");
    else document.documentElement.classList.remove("dark");

    const onChange = (e: MediaQueryListEvent) => {
      setDarkMode(e.matches);
      if (e.matches) document.documentElement.classList.add("dark");
      else document.documentElement.classList.remove("dark");
    };
    mq?.addEventListener?.("change", onChange);
    return () => mq?.removeEventListener?.("change", onChange);
  }, []);

  // Esta función aplica o quita la clase 'dark' al documento
  const toggleDarkMode = () => {
    setDarkMode((prev) => {
      const next = !prev;
      if (next) document.documentElement.classList.add("dark");
      else document.documentElement.classList.remove("dark");
      return next;
    });
  };

  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState<string | null>(null);

  const empresa = useMemo(
    () => ({
      razon_social: "ERSE ELECTRIC SPA",
      rut: "77.638.085-7",
      email: "ventas@erse.cl",
      telefono: "+56 9 4805 4581",
      web: "www.erse.cl",
    }),
    [],
  );

  const [cliente, setCliente] = useState({
    nombre: "",
    rut: "",
    direccion: "",
    direccion_despacho: "",
    ciudad: "",
    atencion: "",
    contacto: "",
    condicion_pago: "",
  });

  const [cotizacion, setCotizacion] = useState({
    numero: "",
    validez: DEFAULT_VALIDEZ,
    moneda: "CLP",
    vendedor: "Carlos Deocares",
    notas: DEFAULT_NOTAS,
  });

  const fechaHoy = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const [items, setItems] = useState<QuoteItem[]>([
    {
      codigo: "",
      descripcion: "",
      cantidad: 1,
      unidad: "UN",
      precio_unitario: 0,
      plazo_entrega: DEFAULT_ITEM_PLAZO_ENTREGA,
      descuento_pct: 0,
    },
  ]);

  const [precioDraftByRow, setPrecioDraftByRow] = useState<Record<number, string>>({});
  const [descuentoGlobalDraft, setDescuentoGlobalDraft] = useState("");
  const descuentoGlobalFocusRef = useRef(false);

  const [clienteLookup, setClienteLookup] = useState<{
    state: "idle" | "loading" | "found" | "not_found" | "error";
    message?: string;
  }>({ state: "idle" });
  const [clienteListaBusqueda, setClienteListaBusqueda] = useState<ClienteListaBusqueda>(null);

  const [productoLookup, setProductoLookup] = useState<Record<number, ProductoLookupState>>({});
  const [productoLookupCampo, setProductoLookupCampo] = useState<
    Record<number, "codigo" | "descripcion">
  >({});
  const [productoSugerenciasPorFila, setProductoSugerenciasPorFila] = useState<
    Record<number, ProductoSugerencia[]>
  >({});

  const clienteRutListaTimerRef = useRef<number | null>(null);
  const clienteNombreListaTimerRef = useRef<number | null>(null);
  const clienteAtencionListaTimerRef = useRef<number | null>(null);
  const itemTimerRef = useRef<Record<number, number | null>>({});
  const descProductoTimerRef = useRef<Record<number, number | null>>({});

  useEffect(() => {
    if (descuentoGlobalFocusRef.current) return;
    if (items.length === 0) {
      setDescuentoGlobalDraft("");
      return;
    }
    const first = items[0].descuento_pct;
    if (items.every((it) => it.descuento_pct === first)) {
      setDescuentoGlobalDraft(String(Math.trunc(first)));
    } else {
      setDescuentoGlobalDraft("");
    }
  }, [items]);

  const totals = useMemo(() => {
    const subtotal = items.reduce((acc, it) => {
      const bruto = it.cantidad * it.precio_unitario;
      const pct = Math.min(100, Math.max(0, it.descuento_pct));
      const factor = 1 - pct / 100;
      return acc + Math.round(bruto * factor);
    }, 0);
    const ivaMonto = Math.round(subtotal * 0.19);
    const total = subtotal + ivaMonto;
    return { subtotal, ivaMonto, total };
  }, [items]);

  function aplicarClienteSugerencia(s: ClienteSugerencia) {
    const rutTrim = s.rut.trim();
    setCliente({
      rut: rutTrim ? formatRutChile(rutTrim) : "",
      nombre: s.nombre,
      direccion: s.direccion,
      direccion_despacho: s.direccion_despacho,
      ciudad: s.ciudad,
      atencion: s.atencion,
      contacto: s.contacto,
      condicion_pago: s.condicion_pago,
    });
    setClienteListaBusqueda(null);
    setClienteLookup({ state: "found", message: "Cliente seleccionado." });
  }

  async function buscarClienteLista(campo: "rut" | "nombre" | "atencion", textoInput: string) {
    const q = sanitizeIlikeFragment(textoInput);
    if (q.length < MIN_BUSQUEDA_CLIENTE_LISTA) {
      setClienteListaBusqueda(null);
      setClienteLookup({ state: "idle" });
      return;
    }

    const tokens = tokenizeBusquedaDesc(q);
    if (tokens.length === 0) {
      setClienteListaBusqueda(null);
      setClienteLookup({ state: "idle" });
      return;
    }

    setClienteListaBusqueda({ campo, estado: "loading", sugerencias: [] });
    setClienteLookup({ state: "idle" });

    try {
      const supabase = getSupabaseClient();
      const tokenPrimario = [...tokens].sort((a, b) => b.length - a.length)[0]!;
      const patternSql = `%${tokenPrimario.slice(0, 120)}%`;

      const cols = [...CLIENTES_ILIKE_COLUMNS[campo]];

      /** Primera columna donde `ilike` responde OK (evita 400 encadenados probando nombres que no existen). */
      const workingCols: string[] = [];
      let lastProbeError: unknown = null;
      for (const col of cols) {
        const res = await supabase.from("clientes").select("*").ilike(col, patternSql).limit(1);
        if (res.error) {
          lastProbeError = res.error;
          continue;
        }
        workingCols.push(col);
        break;
      }

      if (workingCols.length === 0) {
        const hint =
          lastProbeError && typeof lastProbeError === "object" && lastProbeError !== null && "message" in lastProbeError
            ? String((lastProbeError as { message: unknown }).message).slice(0, 180)
            : "Revise en Supabase los nombres de columnas de la tabla clientes.";
        const msg = `No hay columna consultable para este campo. ${hint}`;
        setClienteListaBusqueda({ campo, estado: "error", sugerencias: [] });
        setClienteLookup({ state: "error", message: msg });
        return;
      }

      /** Une filas de todas las columnas válidas (misma lógica que productos con varias claves). */
      const mergedByKey = new Map<string, Record<string, unknown>>();
      const perColLimit = Math.max(80, Math.ceil(MAX_FILAS_CANDIDATAS_CLIENTE / workingCols.length));
      for (const col of workingCols) {
        const full = await supabase.from("clientes").select("*").ilike(col, patternSql).limit(perColLimit);
        if (full.error || !full.data) continue;
        for (const r of full.data as unknown[]) {
          if (!r || typeof r !== "object") continue;
          const row = r as Record<string, unknown>;
          const sug = rowToClienteSugerencia(row);
          if (!sug) continue;
          const k = normalizeRut(sug.rut) || `n:${sug.nombre.toLowerCase().slice(0, 120)}`;
          if (!mergedByKey.has(k)) mergedByKey.set(k, row);
        }
      }

      const rows = [...mergedByKey.values()];
      const mapped = rows
        .map((r) => (r && typeof r === "object" ? rowToClienteSugerencia(r as Record<string, unknown>) : null))
        .filter((x): x is ClienteSugerencia => x !== null);
      const filtradas = dedupeClienteSugerencias(mapped).filter((s) => clienteSugerenciaMatcheaTokens(s, tokens));
      const sugerencias = filtradas.slice(0, MAX_SUGERENCIAS_CLIENTE);

      if (sugerencias.length === 0) {
        setClienteListaBusqueda({ campo, estado: "not_found", sugerencias: [] });
        return;
      }

      setClienteListaBusqueda({ campo, estado: "sugerencias", sugerencias });
    } catch (e) {
      const message =
        e instanceof Error
          ? e.message
          : typeof e === "object" && e !== null && "message" in e
            ? String((e as { message?: unknown }).message)
            : String(e);
      setClienteListaBusqueda({ campo, estado: "error", sugerencias: [] });
      setClienteLookup({ state: "error", message: message || "Error al buscar clientes." });
    }
  }

  async function buscarProductoPorCodigo(idx: number, codigoInput: string) {
    const codigo = codigoInput.trim().toUpperCase();
    if (!codigo) {
      setProductoLookup((p) => ({ ...p, [idx]: "idle" }));
      setProductoLookupCampo((p) => {
        const next = { ...p };
        delete next[idx];
        return next;
      });
      return;
    }

    setProductoLookupCampo((p) => ({ ...p, [idx]: "codigo" }));
    setProductoLookup((p) => ({ ...p, [idx]: "loading" }));
    try {
      const supabase = getSupabaseClient();

      // según tu tabla (captura): CODIGO
      const tryColumns = ["CODIGO", "codigo"];
      let data: unknown[] | null = null;
      let lastError: unknown = null;

      for (const col of tryColumns) {
        const res = await supabase.from("productos").select("*").ilike(col, codigo).limit(1);
        if (!res.error) {
          data = res.data as unknown[] | null;
          lastError = null;
          break;
        }
        lastError = res.error;
      }

      if (lastError) throw lastError;
      const row = Array.isArray(data) ? data[0] : null;
      if (!row) {
        setProductoLookup((p) => ({ ...p, [idx]: "not_found" }));
        return;
      }

      const descripcion =
        (pickFirst(row, ["DESCRIPCIÓN", "DESCRIPCION", "descripcion", "DESCRIPCION", "nombre", "detalle"]) as
          | string
          | undefined) ??
        "";
      const precioSinIvaRaw = pickFirst(row, [
        "Precio Sin IVA",
        "precio_sin_iva",
        "precio sin iva",
        "precioSinIva",
        "precio",
        "precio_unitario",
        "valor",
      ]);
      const precioSinIva = parsePriceCLP(precioSinIvaRaw);
      const unidadRaw = (pickFirst(row, ["UNIDAD", "unidad", "Unidad"]) as string | undefined) ?? "UN";
      const unidad = String(unidadRaw).toUpperCase().slice(0, 3);

      setItems((p) =>
        p.map((it, i) =>
          i === idx
            ? {
                ...it,
                codigo,
                descripcion: descripcion || it.descripcion,
                precio_unitario: Math.max(0, precioSinIva),
                unidad: unidad || it.unidad,
              }
            : it,
        ),
      );
      setProductoLookup((p) => ({ ...p, [idx]: "found" }));
    } catch {
      setProductoLookup((p) => ({ ...p, [idx]: "error" }));
    }
  }

  const MIN_BUSQUEDA_DESC = 3;
  const MAX_SUGERENCIAS_DESC = 25;
  const MAX_FILAS_CANDIDATAS_DESC = 350;
  const DEBOUNCE_DESC_MS = 550;

  function sugerenciaMatcheaTodosLosTokens(s: ProductoSugerencia, tokens: string[]) {
    const hay = foldBusquedaTexto(`${s.descripcion} ${s.codigo}`);
    return tokens.every((t) => hay.includes(foldBusquedaTexto(t)));
  }

  function mapRowToProductoSugerencia(row: unknown): ProductoSugerencia | null {
    if (!row || typeof row !== "object") return null;
    const descripcion =
      (pickFirst(row, ["DESCRIPCIÓN", "DESCRIPCION", "descripcion", "DESCRIPCION", "nombre", "detalle"]) as
        | string
        | undefined) ?? "";
    const codigo = String(pickFirst(row, ["CODIGO", "codigo", "Codigo"]) ?? "")
      .trim()
      .toUpperCase();
    const precioSinIvaRaw = pickFirst(row, [
      "Precio Sin IVA",
      "precio_sin_iva",
      "precio sin iva",
      "precioSinIva",
      "precio",
      "precio_unitario",
      "valor",
    ]);
    const precioLista = Math.max(0, parsePriceCLP(precioSinIvaRaw));
    const unidadRaw = (pickFirst(row, ["UNIDAD", "unidad", "Unidad"]) as string | undefined) ?? "UN";
    const unidad = String(unidadRaw).toUpperCase().slice(0, 3);
    if (!descripcion.trim() && !codigo) return null;
    return { codigo, descripcion: descripcion.trim(), precioLista, unidad };
  }

  function dedupeSugerenciasProducto(list: ProductoSugerencia[]): ProductoSugerencia[] {
    const seen = new Set<string>();
    const out: ProductoSugerencia[] = [];
    for (const s of list) {
      const k = s.codigo ? s.codigo : s.descripcion.slice(0, 120).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
    return out;
  }

  function aplicarProductoSugerencia(idx: number, s: ProductoSugerencia) {
    setItems((p) =>
      p.map((it, i) =>
        i === idx
          ? {
              ...it,
              codigo: s.codigo || it.codigo,
              descripcion: s.descripcion || it.descripcion,
              precio_unitario: s.precioLista,
              unidad: s.unidad || it.unidad,
            }
          : it,
      ),
    );
    setPrecioDraftByRow((p) => {
      const next = { ...p };
      delete next[idx];
      return next;
    });
    setProductoSugerenciasPorFila((p) => {
      const next = { ...p };
      delete next[idx];
      return next;
    });
    setProductoLookup((p) => ({ ...p, [idx]: "found" }));
  }

  async function buscarProductoPorDescripcion(idx: number, textoInput: string) {
    const q = sanitizeIlikeFragment(textoInput);
    if (q.length < MIN_BUSQUEDA_DESC) {
      setProductoLookup((p) => ({ ...p, [idx]: "idle" }));
      setProductoSugerenciasPorFila((p) => {
        const next = { ...p };
        delete next[idx];
        return next;
      });
      setProductoLookupCampo((p) => {
        const next = { ...p };
        delete next[idx];
        return next;
      });
      return;
    }

    setProductoLookupCampo((p) => ({ ...p, [idx]: "descripcion" }));
    setProductoLookup((p) => ({ ...p, [idx]: "loading" }));
    setProductoSugerenciasPorFila((p) => {
      const next = { ...p };
      delete next[idx];
      return next;
    });
    try {
      const supabase = getSupabaseClient();
      const tokens = tokenizeBusquedaDesc(q);
      if (tokens.length === 0) {
        setProductoLookup((p) => ({ ...p, [idx]: "not_found" }));
        return;
      }
      /** Palabra más larga: mejor filtro en SQL; el resto se exige en cliente (cualquier orden). */
      const tokenPrimario = [...tokens].sort((a, b) => b.length - a.length)[0]!;
      const patternSql = `%${tokenPrimario.slice(0, 120)}%`;

      const tryColumns = [
        "DESCRIPCION",
        "DESCRIPCIÓN",
        "descripcion",
        "Descripcion",
        "NOMBRE",
        "nombre",
        "DETALLE",
        "detalle",
      ];
      const seen = new Set<string>();
      const cols = tryColumns.filter((c) => {
        if (seen.has(c)) return false;
        seen.add(c);
        return true;
      });

      let workCol: string | null = null;
      let lastError: unknown = null;
      for (const col of cols) {
        const res = await supabase.from("productos").select("*").ilike(col, patternSql).limit(1);
        if (res.error) {
          lastError = res.error;
          continue;
        }
        workCol = col;
        lastError = null;
        break;
      }

      if (!workCol) {
        if (lastError) throw lastError;
        setProductoLookup((p) => ({ ...p, [idx]: "not_found" }));
        return;
      }

      const full = await supabase
        .from("productos")
        .select("*")
        .ilike(workCol, patternSql)
        .limit(MAX_FILAS_CANDIDATAS_DESC);
      if (full.error) throw full.error;
      const rows = (full.data as unknown[] | null) ?? [];
      const mapped = rows
        .map((r) => mapRowToProductoSugerencia(r))
        .filter((x): x is ProductoSugerencia => x !== null);
      const filtradas = dedupeSugerenciasProducto(mapped).filter((s) =>
        sugerenciaMatcheaTodosLosTokens(s, tokens),
      );
      const sugerencias = filtradas.slice(0, MAX_SUGERENCIAS_DESC);

      if (sugerencias.length === 0) {
        setProductoLookup((p) => ({ ...p, [idx]: "not_found" }));
        return;
      }

      setProductoSugerenciasPorFila((p) => ({ ...p, [idx]: sugerencias }));
      setProductoLookup((p) => ({ ...p, [idx]: "sugerencias" }));
    } catch {
      setProductoLookup((p) => ({ ...p, [idx]: "error" }));
      setProductoSugerenciasPorFila((p) => {
        const next = { ...p };
        delete next[idx];
        return next;
      });
    }
  }

  function handleDownloadPdf() {
    void generatePDF({
      empresa,
      cliente,
      cotizacion: {
        numero: cotizacion.numero,
        validez: cotizacion.validez,
        moneda: cotizacion.moneda,
        vendedor: cotizacion.vendedor,
      },
      fecha: fechaHoy,
      items,
      totals,
      notas: cotizacion.notas,
    });
  }

  async function handleSave() {
    setIsSaving(true);
    setSaveError(null);
    setSaveOk(null);
    try {
      const digitsNumeroCot = String(cotizacion.numero).replace(/\D/g, "");
      const formData = {
        numero_cotizacion: digitsNumeroCot.length > 0 ? digitsNumeroCot : "0",
        subtotal_neto: totals.subtotal,
        iva: totals.ivaMonto,
        total: totals.total,
      };

      // Sin `items` en el insert hasta que definas la columna jsonb en Supabase (opción 1).
      const row = {
        numero_cotizacion: parseInt(String(formData.numero_cotizacion), 10) || 0,
        fecha: fechaHoy,
        cliente_nombre: cliente.nombre.trim() || "",
        cliente_rut: cliente.rut.trim() || "",
        atencion: cliente.atencion.trim() || "",
        direccion_despacho: cliente.direccion_despacho.trim() || "",
        subtotal_neto: Number(formData.subtotal_neto) || 0,
        iva: Number(formData.iva) || 0,
        total: Number(formData.total) || 0,
      };

      const supabase = getSupabaseClient();
      const { error } = await supabase.from("cotizaciones").insert(row as never);

      if (error) {
        console.error("Error detallado:", error.message, error.details, error.hint);
        setSaveError(
          [error.message, error.details, error.hint].filter((x) => x != null && String(x).trim() !== "").join(" — ") ||
            error.message,
        );
        return;
      }

      setSaveOk("Cotización guardada correctamente en Supabase.");
    } catch (e) {
      const err = e as { message?: string; details?: string; hint?: string };
      if (typeof err?.message === "string") {
        console.error("Error detallado:", err.message, err.details, err.hint);
        setSaveError(
          [err.message, err.details, err.hint].filter((x) => x != null && String(x).trim() !== "").join(" — ") ||
            err.message,
        );
      } else {
        console.error("Error detallado:", e);
        setSaveError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="min-h-dvh bg-gray-50 text-gray-900 dark:bg-slate-900 dark:text-white">
      <div className="mx-auto w-full max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
        <button
          onClick={toggleDarkMode}
          className="fixed top-4 right-4 p-2 rounded-full bg-gray-200 dark:bg-slate-700 text-gray-800 dark:text-yellow-400 transition-all shadow-lg z-50"
          title="Cambiar modo"
          type="button"
        >
          {darkMode ? (
            /* Icono Sol */
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m12.728 0l-.707-.707M6.343 6.343l-.707-.707"
              />
            </svg>
          ) : (
            /* Icono Luna */
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
              />
            </svg>
          )}
        </button>

        <header className="mb-6 flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="relative h-24 w-[336px] shrink-0">
              <Image
                src="/logo-erse.png"
                alt="ERSE Electric"
                fill
                sizes="336px"
                className="object-contain"
                priority
              />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Formulario de Cotización</h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-slate-300">
              ERSE ELECTRIC SPA · Guardado directo a Supabase (`cotizaciones`)
            </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleDarkMode}
              className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-900 hover:bg-gray-50 dark:border-slate-700 dark:bg-slate-800 dark:text-white dark:hover:bg-slate-700"
              title={darkMode ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
              aria-label={darkMode ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
            >
              {darkMode ? (
                // Sol
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z"
                    stroke="currentColor"
                    strokeWidth="2"
                  />
                  <path
                    d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              ) : (
                // Luna
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M21 14.5A8.5 8.5 0 0 1 9.5 3a7 7 0 1 0 11.5 11.5Z"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>

            <button
              type="button"
              onClick={handleDownloadPdf}
              className="rounded bg-gray-800 px-4 py-2 text-white shadow hover:bg-gray-700"
            >
              Descargar PDF
            </button>

            <button
              onClick={handleSave}
              disabled={isSaving}
              className="inline-flex h-11 items-center justify-center rounded-xl bg-zinc-900 px-5 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSaving ? "Guardando..." : "Guardar en Supabase"}
            </button>
          </div>
        </header>

        <section className="mb-6 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">Datos de Empresa</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="grid gap-1">
              <span className="text-sm font-semibold text-zinc-700 dark:text-gray-100">RUT</span>
              <span className="text-sm text-zinc-900 dark:text-white">{empresa.rut || "—"}</span>
            </div>
            <div className="grid gap-1">
              <span className="text-sm font-semibold text-zinc-700 dark:text-gray-100">Razón Social</span>
              <span className="text-sm text-zinc-900 dark:text-white">{empresa.razon_social}</span>
            </div>
            <div className="grid gap-1">
              <span className="text-sm font-semibold text-zinc-700 dark:text-gray-100">Email</span>
              <span className="text-sm text-zinc-900 dark:text-white">{empresa.email}</span>
            </div>
            <div className="grid gap-1">
              <span className="text-sm font-semibold text-zinc-700 dark:text-gray-100">Web</span>
              <span className="text-sm text-zinc-900 dark:text-white">{empresa.web}</span>
            </div>
            <div className="grid gap-1">
              <span className="text-sm font-semibold text-zinc-700 dark:text-gray-100">Teléfono / WhatsApp</span>
              <span className="text-sm text-zinc-900 dark:text-white">{empresa.telefono || "—"}</span>
            </div>
          </div>
        </section>

        {(saveError || saveOk) && (
          <div className="mb-6">
            {saveOk && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
                {saveOk}
              </div>
            )}
            {saveError && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
                Error: {saveError}
              </div>
            )}
          </div>
        )}

        <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">Datos de Cliente</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="SEÑOR(ES)">
                <input
                  value={cliente.nombre}
                  onChange={(e) => {
                    const value = e.target.value;
                    setCliente((p) => ({ ...p, nombre: value }));
                    if (clienteNombreListaTimerRef.current) window.clearTimeout(clienteNombreListaTimerRef.current);
                    clienteNombreListaTimerRef.current = window.setTimeout(() => {
                      void buscarClienteLista("nombre", value);
                    }, DEBOUNCE_CLIENTE_MS);
                  }}
                  onBlur={(e) => void buscarClienteLista("nombre", e.target.value)}
                  className="input font-semibold text-black placeholder:text-zinc-700 opacity-100 dark:bg-white dark:text-black dark:placeholder:text-zinc-500"
                  placeholder="3+ caracteres; varias palabras en cualquier orden…"
                />
                {clienteListaBusqueda?.campo === "nombre" && (
                  <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    {clienteListaBusqueda.estado === "loading" && "Buscando..."}
                    {clienteListaBusqueda.estado === "sugerencias" && (
                      <span>
                        {clienteListaBusqueda.sugerencias.length} coincidencias — elija una abajo
                      </span>
                    )}
                    {clienteListaBusqueda.estado === "not_found" && "Sin coincidencias"}
                    {clienteListaBusqueda.estado === "error" && (
                      <span className="text-rose-700 dark:text-rose-300">
                        {clienteLookup.message || "Error al buscar"}
                      </span>
                    )}
                  </div>
                )}
                {clienteListaBusqueda?.campo === "nombre" &&
                  clienteListaBusqueda.estado === "sugerencias" &&
                  clienteListaBusqueda.sugerencias.length > 0 && (
                    <ul
                      className="mt-2 max-h-52 min-w-[16rem] max-w-xl overflow-auto rounded-xl border border-zinc-200 bg-white py-1 text-left shadow-sm dark:border-slate-600 dark:bg-slate-800"
                      role="listbox"
                    >
                      {clienteListaBusqueda.sugerencias.map((sug, j) => (
                        <li key={`${sug.rut}-${j}-${sug.nombre.slice(0, 20)}`}>
                          <button
                            type="button"
                            role="option"
                            className="flex w-full flex-col gap-0.5 px-3 py-2 text-left text-xs hover:bg-zinc-100 dark:hover:bg-slate-700"
                            onMouseDown={(ev) => {
                              ev.preventDefault();
                              aplicarClienteSugerencia(sug);
                            }}
                          >
                            <span className="font-bold text-zinc-900 dark:text-white">
                              {sug.rut.trim() ? formatRutChile(sug.rut.trim()) : "—"}
                            </span>
                            <span className="line-clamp-2 text-zinc-700 dark:text-zinc-200">{sug.nombre}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
              </Field>
              <Field label="RUT">
                <input
                  value={cliente.rut}
                  onChange={(e) => {
                    const value = e.target.value;
                    setCliente((p) => ({ ...p, rut: value }));
                    if (clienteRutListaTimerRef.current) window.clearTimeout(clienteRutListaTimerRef.current);
                    clienteRutListaTimerRef.current = window.setTimeout(() => {
                      void buscarClienteLista("rut", value);
                    }, DEBOUNCE_CLIENTE_MS);
                  }}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    const formatted = v ? formatRutChile(v) : "";
                    setCliente((p) => ({ ...p, rut: formatted }));
                    void buscarClienteLista("rut", formatted);
                  }}
                  className="input font-semibold text-black placeholder:text-zinc-700 opacity-100 dark:bg-white dark:text-black dark:placeholder:text-zinc-500"
                  placeholder="3+ caracteres; varias palabras (espacio o coma)…"
                />
                {(!clienteListaBusqueda || clienteListaBusqueda.campo === "rut") && (
                  <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    {clienteListaBusqueda?.campo === "rut" && clienteListaBusqueda.estado === "loading" && "Buscando..."}
                    {clienteListaBusqueda?.campo === "rut" && clienteListaBusqueda.estado === "sugerencias" && (
                      <span>
                        {clienteListaBusqueda.sugerencias.length} coincidencias — elija una abajo
                      </span>
                    )}
                    {clienteListaBusqueda?.campo === "rut" && clienteListaBusqueda.estado === "not_found" && "Sin coincidencias"}
                    {clienteListaBusqueda?.campo === "rut" && clienteListaBusqueda.estado === "error" && (
                      <span className="text-rose-700 dark:text-rose-300">
                        {clienteLookup.message || "Error al buscar"}
                      </span>
                    )}
                    {(!clienteListaBusqueda || clienteListaBusqueda.campo === "rut") &&
                      (!clienteListaBusqueda || clienteListaBusqueda.estado !== "loading") &&
                      clienteLookup.state === "found" &&
                      clienteLookup.message}
                    {(!clienteListaBusqueda || clienteListaBusqueda.campo === "rut") &&
                      clienteLookup.state === "error" &&
                      `Error: ${clienteLookup.message ?? ""}`}
                  </div>
                )}
                {clienteListaBusqueda?.campo === "rut" &&
                  clienteListaBusqueda.estado === "sugerencias" &&
                  clienteListaBusqueda.sugerencias.length > 0 && (
                    <ul
                      className="mt-2 max-h-52 min-w-[16rem] max-w-xl overflow-auto rounded-xl border border-zinc-200 bg-white py-1 text-left shadow-sm dark:border-slate-600 dark:bg-slate-800"
                      role="listbox"
                    >
                      {clienteListaBusqueda.sugerencias.map((sug, j) => (
                        <li key={`${sug.rut}-${j}-${sug.nombre.slice(0, 20)}`}>
                          <button
                            type="button"
                            role="option"
                            className="flex w-full flex-col gap-0.5 px-3 py-2 text-left text-xs hover:bg-zinc-100 dark:hover:bg-slate-700"
                            onMouseDown={(ev) => {
                              ev.preventDefault();
                              aplicarClienteSugerencia(sug);
                            }}
                          >
                            <span className="font-bold text-zinc-900 dark:text-white">
                              {sug.rut.trim() ? formatRutChile(sug.rut.trim()) : "—"}
                            </span>
                            <span className="line-clamp-2 text-zinc-700 dark:text-zinc-200">{sug.nombre}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
              </Field>
              <Field label="Dirección despacho">
                <input
                  value={cliente.direccion_despacho}
                  onChange={(e) => setCliente((p) => ({ ...p, direccion_despacho: e.target.value }))}
                  className="input font-semibold text-black placeholder:text-zinc-700 opacity-100 dark:bg-white dark:text-black dark:placeholder:text-zinc-500"
                />
              </Field>
              <Field label="Ciudad">
                <input
                  value={cliente.ciudad}
                  onChange={(e) => setCliente((p) => ({ ...p, ciudad: e.target.value }))}
                  className="input font-semibold text-black placeholder:text-zinc-700 opacity-100 dark:bg-white dark:text-black dark:placeholder:text-zinc-500"
                />
              </Field>
              <Field label="Contacto">
                <input
                  value={cliente.contacto}
                  onChange={(e) => setCliente((p) => ({ ...p, contacto: e.target.value }))}
                  className="input font-semibold text-black placeholder:text-zinc-700 opacity-100 dark:bg-white dark:text-black dark:placeholder:text-zinc-500"
                />
              </Field>
              <Field label="Persona (Atención)">
                <input
                  value={cliente.atencion}
                  onChange={(e) => {
                    const value = e.target.value;
                    setCliente((p) => ({ ...p, atencion: value }));
                    if (clienteAtencionListaTimerRef.current) window.clearTimeout(clienteAtencionListaTimerRef.current);
                    clienteAtencionListaTimerRef.current = window.setTimeout(() => {
                      void buscarClienteLista("atencion", value);
                    }, DEBOUNCE_CLIENTE_MS);
                  }}
                  onBlur={(e) => void buscarClienteLista("atencion", e.target.value)}
                  className="input font-semibold text-black placeholder:text-zinc-700 opacity-100 dark:bg-white dark:text-black dark:placeholder:text-zinc-500"
                  placeholder="3+ caracteres; varias palabras en cualquier orden…"
                />
                {clienteListaBusqueda?.campo === "atencion" && (
                  <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    {clienteListaBusqueda.estado === "loading" && "Buscando..."}
                    {clienteListaBusqueda.estado === "sugerencias" && (
                      <span>
                        {clienteListaBusqueda.sugerencias.length} coincidencias — elija una abajo
                      </span>
                    )}
                    {clienteListaBusqueda.estado === "not_found" && "Sin coincidencias"}
                    {clienteListaBusqueda.estado === "error" && (
                      <span className="text-rose-700 dark:text-rose-300">
                        {clienteLookup.message || "Error al buscar"}
                      </span>
                    )}
                  </div>
                )}
                {clienteListaBusqueda?.campo === "atencion" &&
                  clienteListaBusqueda.estado === "sugerencias" &&
                  clienteListaBusqueda.sugerencias.length > 0 && (
                    <ul
                      className="mt-2 max-h-52 min-w-[16rem] max-w-xl overflow-auto rounded-xl border border-zinc-200 bg-white py-1 text-left shadow-sm dark:border-slate-600 dark:bg-slate-800"
                      role="listbox"
                    >
                      {clienteListaBusqueda.sugerencias.map((sug, j) => (
                        <li key={`at-${sug.rut}-${j}-${(sug.atencion || sug.nombre).slice(0, 16)}`}>
                          <button
                            type="button"
                            role="option"
                            className="flex w-full flex-col gap-0.5 px-3 py-2 text-left text-xs hover:bg-zinc-100 dark:hover:bg-slate-700"
                            onMouseDown={(ev) => {
                              ev.preventDefault();
                              aplicarClienteSugerencia(sug);
                            }}
                          >
                            <span className="font-bold text-zinc-900 dark:text-white">
                              {sug.rut.trim() ? formatRutChile(sug.rut.trim()) : "—"}
                            </span>
                            <span className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">
                              {sug.nombre}
                            </span>
                            <span className="line-clamp-2 text-zinc-700 dark:text-zinc-200">
                              Atención: {sug.atencion || "—"}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
              </Field>
              <Field label="Condición de Pago">
                <input
                  value={cliente.condicion_pago}
                  onChange={(e) => setCliente((p) => ({ ...p, condicion_pago: e.target.value }))}
                  className="input font-semibold text-black placeholder:text-zinc-700 opacity-100 dark:bg-white dark:text-black dark:placeholder:text-zinc-500"
                />
              </Field>
          </div>
        </section>

        <section className="mt-6 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">Datos de Cotización</h2>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-zinc-700 dark:text-gray-100">Moneda</span>
              <select
                value={cotizacion.moneda}
                onChange={(e) => setCotizacion((p) => ({ ...p, moneda: e.target.value }))}
                className="h-9 rounded-lg border border-zinc-200 bg-white px-2 text-sm font-semibold text-black dark:bg-white dark:text-black dark:border-zinc-200"
              >
                <option value="CLP">CLP</option>
                <option value="USD">USD</option>
              </select>
            </div>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Field label="N° Cotización">
              <input
                value={cotizacion.numero}
                onChange={(e) => setCotizacion((p) => ({ ...p, numero: e.target.value }))}
                className="input font-semibold text-black placeholder:text-zinc-700 opacity-100 dark:bg-white dark:text-black dark:placeholder:text-zinc-500"
              />
            </Field>
            <Field label="Fecha">
              <input
                type="date"
                value={fechaHoy}
                readOnly
                className="input font-semibold text-black opacity-100 dark:bg-white dark:text-black dark:border-zinc-200"
              />
            </Field>
            <Field label="Validez">
              <input
                value={cotizacion.validez}
                onChange={(e) => setCotizacion((p) => ({ ...p, validez: e.target.value }))}
                onBlur={() =>
                  setCotizacion((p) => ({
                    ...p,
                    validez: p.validez.trim() ? p.validez : DEFAULT_VALIDEZ,
                  }))
                }
                className="input font-semibold text-black placeholder:text-zinc-700 opacity-100 dark:bg-white dark:text-black dark:border-zinc-200 dark:placeholder:text-zinc-700"
                placeholder={DEFAULT_VALIDEZ}
              />
            </Field>
            <Field label="Vendedor(a)">
              <input
                value={cotizacion.vendedor}
                onChange={(e) => setCotizacion((p) => ({ ...p, vendedor: e.target.value }))}
                className="input font-semibold text-black placeholder:text-zinc-700 opacity-100 dark:bg-white dark:text-black dark:placeholder:text-zinc-500"
                placeholder="Nombre del vendedor(a)"
              />
            </Field>
          </div>
        </section>

        <section className="mt-6 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">Detalle</h2>
            <div className="flex flex-wrap items-end justify-end gap-4">
              <div className="flex min-w-[10rem] flex-col gap-1 border-l border-zinc-200 pl-4 dark:border-slate-600">
                <label
                  htmlFor="descuento-global-pct"
                  className="text-xs font-bold text-zinc-700 dark:text-gray-100"
                >
                  % desc. todas las líneas
                </label>
                <input
                  id="descuento-global-pct"
                  value={descuentoGlobalDraft}
                  onChange={(e) => setDescuentoGlobalDraft(e.target.value)}
                  onFocus={() => {
                    descuentoGlobalFocusRef.current = true;
                  }}
                  onBlur={() => {
                    descuentoGlobalFocusRef.current = false;
                    const trimmed = descuentoGlobalDraft.trim();
                    if (trimmed === "") {
                      const f = items[0]?.descuento_pct;
                      if (items.length > 0 && items.every((it) => it.descuento_pct === f)) {
                        setDescuentoGlobalDraft(String(Math.trunc(f)));
                      }
                      return;
                    }
                    const v = Math.min(100, Math.max(0, toNumber(descuentoGlobalDraft)));
                    setItems((p) => p.map((it) => ({ ...it, descuento_pct: v })));
                    setDescuentoGlobalDraft(String(Math.trunc(v)));
                    setPrecioDraftByRow({});
                  }}
                  size={Math.min(4, Math.max(2, descuentoGlobalDraft.length || 1))}
                  maxLength={4}
                  inputMode="decimal"
                  title="Al salir del campo se aplica el mismo % a todas las filas"
                  className="input w-auto min-w-[3.5rem] font-semibold text-right text-black placeholder:text-zinc-700 opacity-100 dark:bg-white dark:text-black dark:border-zinc-200 dark:placeholder:text-zinc-700"
                  placeholder="0"
                />
              </div>
              <button
                onClick={() =>
                  setItems((p) => {
                    const pctNuevo = p.length && p.every((it) => it.descuento_pct === p[0].descuento_pct) ? p[0].descuento_pct : 0;
                    return [
                      ...p,
                      {
                        codigo: "",
                        descripcion: "",
                        cantidad: 1,
                        unidad: "UN",
                        precio_unitario: 0,
                        plazo_entrega: DEFAULT_ITEM_PLAZO_ENTREGA,
                        descuento_pct: pctNuevo,
                      },
                    ];
                  })
                }
                className="h-10 rounded-xl border border-gray-200 bg-white px-4 text-sm font-medium text-gray-900 hover:bg-gray-50 dark:border-gray-200 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-50"
              >
                + Agregar ítem
              </button>
            </div>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="min-w-[900px] w-full border-separate border-spacing-0">
              <thead>
                <tr className="text-left text-xs font-bold text-zinc-700 dark:text-gray-100">
                  <th className="border-b border-zinc-200 pb-2 pr-3 w-12">N°</th>
                  <th className="border-b border-zinc-200 pb-2 pr-3 w-36">CÓDIGO</th>
                  <th className="border-b border-zinc-200 pb-2 pr-3">Descripción</th>
                  <th className="border-b border-zinc-200 pb-2 pr-2 w-0 whitespace-nowrap">Cant.</th>
                  <th className="border-b border-zinc-200 pb-2 pr-2 w-0 whitespace-nowrap">Unidad</th>
                  <th className="border-b border-zinc-200 pb-2 pr-2 w-0 whitespace-nowrap">Plazo entrega</th>
                  <th className="border-b border-zinc-200 pb-2 pr-2 w-0 whitespace-nowrap">{P_UNITARIO_LABEL}</th>
                  <th className="border-b border-zinc-200 pb-2 pr-3 w-40">Total</th>
                  <th className="border-b border-zinc-200 pb-2 w-14 sticky right-[5.5rem] z-10 bg-white shadow-[-10px_0_14px_-6px_rgba(0,0,0,0.12)] dark:bg-slate-800 dark:shadow-[-10px_0_14px_-6px_rgba(0,0,0,0.35)]" />
                  <th className="border-b border-zinc-200 pb-2 pl-2 w-[5.5rem] min-w-[5.5rem] text-right sticky right-0 z-10 bg-white border-l border-zinc-200 shadow-[-10px_0_14px_-6px_rgba(0,0,0,0.12)] dark:bg-slate-800 dark:border-slate-600 dark:text-gray-100 dark:shadow-[-10px_0_14px_-6px_rgba(0,0,0,0.35)]">
                    % desc.
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, idx) => {
                  const bruto = it.cantidad * it.precio_unitario;
                  const pct = Math.min(100, Math.max(0, it.descuento_pct));
                  const totalItem = Math.round(bruto * (1 - pct / 100));
                  const cantidadText = String(it.cantidad);
                  const unidadText = it.unidad;
                  const plazoText = it.plazo_entrega;
                  const descuentoText = String(Math.trunc(it.descuento_pct));
                  // +1 deja un “espacio de tipeo” sin inflar demasiado el ancho
                  const cantidadSize = Math.min(7, Math.max(1, cantidadText.length));
                  const unidadSize = Math.min(3, Math.max(1, unidadText.length));
                  const plazoSize = Math.min(16, Math.max(1, plazoText.length));
                  const descuentoSize = Math.min(3, Math.max(1, descuentoText.length));
                  const precioEfectivo = precioUnitarioEfectivo(it.precio_unitario, pct);
                  const precioDisplayText = precioDraftByRow[idx] ?? formatMiles(precioEfectivo);
                  const precioSize = Math.min(24, Math.max(P_UNITARIO_LABEL.length, precioDisplayText.length + 1));
                  const showProdCodigo = productoLookupCampo[idx] !== "descripcion";
                  const showProdDescripcion = productoLookupCampo[idx] === "descripcion";
                  return (
                    <tr key={idx} className="text-sm">
                      <td className="border-b border-zinc-100 py-3 pr-3 align-top font-bold text-zinc-700 tabular-nums dark:text-gray-100">
                        {idx + 1}
                      </td>
                      <td className="border-b border-zinc-100 py-3 pr-3 align-top">
                        <input
                          value={it.codigo}
                          onChange={(e) => {
                            const value = e.target.value.toUpperCase();
                            setItems((p) => p.map((row, i) => (i === idx ? { ...row, codigo: value } : row)));

                            const current = itemTimerRef.current[idx];
                            if (current) window.clearTimeout(current);
                            itemTimerRef.current[idx] = window.setTimeout(() => {
                              void buscarProductoPorCodigo(idx, value);
                            }, 400);
                          }}
                          onBlur={() => void buscarProductoPorCodigo(idx, it.codigo)}
                          className="input font-semibold text-black placeholder:text-zinc-700 opacity-100 dark:bg-white dark:text-black dark:border-zinc-200 dark:placeholder:text-zinc-700"
                          placeholder="CODIGO"
                        />
                        {showProdCodigo && (
                          <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                            {productoLookup[idx] === "loading" && "Buscando..."}
                            {productoLookup[idx] === "found" && (
                              <span className="font-semibold text-zinc-900 dark:text-white">OK</span>
                            )}
                            {productoLookup[idx] === "not_found" && "No existe"}
                            {productoLookup[idx] === "error" && "Error"}
                          </div>
                        )}
                      </td>
                      <td className="border-b border-zinc-100 py-3 pr-3 align-top">
                        <input
                          value={it.descripcion}
                          onChange={(e) => {
                            const value = e.target.value;
                            setItems((p) =>
                              p.map((row, i) => (i === idx ? { ...row, descripcion: value } : row)),
                            );
                            const current = descProductoTimerRef.current[idx];
                            if (current) window.clearTimeout(current);
                            descProductoTimerRef.current[idx] = window.setTimeout(() => {
                              void buscarProductoPorDescripcion(idx, value);
                            }, DEBOUNCE_DESC_MS);
                          }}
                          onBlur={(e) => void buscarProductoPorDescripcion(idx, e.target.value)}
                          className="input font-semibold text-black placeholder:text-zinc-700 opacity-100 dark:bg-white dark:text-black dark:border-zinc-200 dark:placeholder:text-zinc-700"
                          placeholder="3+ caracteres; varias palabras en cualquier orden (espacio o coma)…"
                        />
                        {showProdDescripcion && (
                          <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                            {productoLookup[idx] === "loading" && "Buscando..."}
                            {productoLookup[idx] === "sugerencias" && (
                              <span>
                                {productoSugerenciasPorFila[idx]?.length ?? 0} coincidencias — elija una abajo
                              </span>
                            )}
                            {productoLookup[idx] === "found" && (
                              <span className="font-semibold text-zinc-900 dark:text-white">OK</span>
                            )}
                            {productoLookup[idx] === "not_found" && "No existe"}
                            {productoLookup[idx] === "error" && "Error"}
                          </div>
                        )}
                        {showProdDescripcion &&
                          productoLookup[idx] === "sugerencias" &&
                          (productoSugerenciasPorFila[idx]?.length ?? 0) > 0 && (
                            <ul
                              className="mt-2 max-h-52 min-w-[16rem] max-w-xl overflow-auto rounded-xl border border-zinc-200 bg-white py-1 shadow-sm dark:border-slate-600 dark:bg-slate-800"
                              role="listbox"
                            >
                              {productoSugerenciasPorFila[idx]!.map((sug, j) => (
                                <li key={`${sug.codigo || "x"}-${j}-${sug.descripcion.slice(0, 24)}`}>
                                  <button
                                    type="button"
                                    role="option"
                                    className="flex w-full flex-col gap-0.5 px-3 py-2 text-left text-xs hover:bg-zinc-100 dark:hover:bg-slate-700"
                                    onMouseDown={(ev) => {
                                      ev.preventDefault();
                                      aplicarProductoSugerencia(idx, sug);
                                    }}
                                  >
                                    <span className="font-bold text-zinc-900 dark:text-white">
                                      {sug.codigo || "—"}{" "}
                                      <span className="font-semibold text-zinc-600 dark:text-zinc-300">
                                        {formatMiles(sug.precioLista)}
                                      </span>
                                    </span>
                                    <span className="line-clamp-2 text-zinc-700 dark:text-zinc-200">
                                      {sug.descripcion}
                                    </span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                      </td>
                      <td className="border-b border-zinc-100 py-3 pr-2 align-top w-0 whitespace-nowrap">
                        <span className="inline-block max-w-full">
                          <input
                            type="number"
                            value={String(it.cantidad)}
                            onChange={(e) =>
                              setItems((p) =>
                                p.map((row, i) =>
                                  i === idx ? { ...row, cantidad: Math.max(0, toNumber(e.target.value)) } : row,
                                ),
                              )
                            }
                            size={cantidadSize}
                            min={0}
                            step={1}
                            className="input !w-auto min-w-0 max-w-full font-semibold text-right text-black placeholder:text-zinc-700 opacity-100 dark:bg-white dark:text-black dark:border-zinc-200 dark:placeholder:text-zinc-700"
                          />
                        </span>
                      </td>
                      <td className="border-b border-zinc-100 py-3 pr-2 align-top w-0 whitespace-nowrap">
                        <span className="inline-block max-w-full">
                          <input
                            value={it.unidad}
                            onChange={(e) =>
                              setItems((p) =>
                                p.map((row, i) =>
                                  i === idx ? { ...row, unidad: e.target.value.toUpperCase().slice(0, 3) } : row,
                                ),
                              )
                            }
                            size={unidadSize}
                            maxLength={3}
                            className="input !w-auto min-w-0 max-w-full font-semibold text-black placeholder:text-zinc-700 opacity-100 dark:bg-white dark:text-black dark:border-zinc-200 dark:placeholder:text-zinc-700"
                          />
                        </span>
                      </td>
                      <td className="border-b border-zinc-100 py-3 pr-2 align-top w-0 whitespace-nowrap">
                        <span className="inline-block max-w-full">
                          <input
                            value={it.plazo_entrega}
                            onChange={(e) =>
                              setItems((p) =>
                                p.map((row, i) =>
                                  i === idx ? { ...row, plazo_entrega: e.target.value.slice(0, 16) } : row,
                                ),
                              )
                            }
                            onBlur={() =>
                              setItems((p) =>
                                p.map((row, i) =>
                                  i === idx
                                    ? {
                                        ...row,
                                        plazo_entrega: row.plazo_entrega.trim()
                                          ? row.plazo_entrega
                                          : DEFAULT_ITEM_PLAZO_ENTREGA,
                                      }
                                    : row,
                                ),
                              )
                            }
                            size={plazoSize}
                            maxLength={16}
                            className="input !w-auto min-w-0 max-w-full font-semibold text-black placeholder:text-zinc-700 opacity-100 dark:bg-white dark:text-black dark:border-zinc-200 dark:placeholder:text-zinc-700"
                            placeholder={DEFAULT_ITEM_PLAZO_ENTREGA}
                          />
                        </span>
                      </td>
                      <td className="border-b border-zinc-100 py-3 pr-2 align-top w-0 whitespace-nowrap">
                        <span className="inline-block max-w-full">
                          <input
                            value={precioDisplayText}
                            onFocus={() =>
                              setPrecioDraftByRow((p) => ({
                                ...p,
                                [idx]: String(Math.max(0, precioEfectivo)),
                              }))
                            }
                            onChange={(e) => {
                              const next = e.target.value;
                              setPrecioDraftByRow((p) => ({ ...p, [idx]: next }));
                            }}
                            onBlur={() => {
                              const raw = precioDraftByRow[idx] ?? String(precioEfectivo);
                              const parsedEfectivo = Math.max(0, parseMilesEntero(raw));
                              const parsedLista = precioListaDesdeEfectivo(parsedEfectivo, pct);
                              setItems((p) =>
                                p.map((row, i) => (i === idx ? { ...row, precio_unitario: parsedLista } : row)),
                              );
                              setPrecioDraftByRow((p) => {
                                const next = { ...p };
                                delete next[idx];
                                return next;
                              });
                            }}
                            size={precioSize}
                            className="input !w-auto min-w-0 max-w-full font-semibold text-right text-black placeholder:text-zinc-700 opacity-100 dark:bg-white dark:text-black dark:border-zinc-200 dark:placeholder:text-zinc-700"
                            inputMode="numeric"
                          />
                        </span>
                      </td>
                      <td className="border-b border-zinc-100 py-3 pr-3 align-top">
                        <div className="h-11 rounded-xl border border-zinc-200 bg-zinc-50 px-3 flex items-center justify-end dark:bg-zinc-50 dark:text-black dark:border-zinc-200">
                          <span className="tabular-nums text-sm font-semibold">{formatMiles(totalItem)}</span>
                        </div>
                      </td>
                      <td className="border-b border-zinc-100 py-3 align-top w-14 sticky right-[5.5rem] z-10 bg-white shadow-[-10px_0_14px_-6px_rgba(0,0,0,0.12)] dark:bg-slate-800 dark:shadow-[-10px_0_14px_-6px_rgba(0,0,0,0.35)]">
                        <button
                          type="button"
                          onClick={() => {
                            setItems((p) => p.filter((_, i) => i !== idx));
                            setPrecioDraftByRow({});
                          }}
                          className="h-11 w-11 rounded-xl border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:border-zinc-200 dark:hover:bg-zinc-50"
                          disabled={items.length <= 1}
                          title="Eliminar ítem"
                        >
                          ×
                        </button>
                      </td>
                      <td className="border-b border-zinc-100 py-3 pl-2 align-top w-[5.5rem] min-w-[5.5rem] sticky right-0 z-10 bg-white border-l border-zinc-100 shadow-[-10px_0_14px_-6px_rgba(0,0,0,0.12)] dark:bg-slate-800 dark:border-slate-600 dark:shadow-[-10px_0_14px_-6px_rgba(0,0,0,0.35)]">
                        <span className="inline-block max-w-full">
                          <input
                            value={String(Math.trunc(it.descuento_pct))}
                            onChange={(e) => {
                              setPrecioDraftByRow((p) => {
                                const next = { ...p };
                                delete next[idx];
                                return next;
                              });
                              setItems((p) =>
                                p.map((row, i) =>
                                  i === idx
                                    ? { ...row, descuento_pct: Math.min(100, Math.max(0, toNumber(e.target.value))) }
                                    : row,
                                ),
                              );
                            }}
                            size={descuentoSize}
                            maxLength={3}
                            className="input !w-auto min-w-0 max-w-full font-semibold text-right text-black placeholder:text-zinc-700 opacity-100 dark:bg-white dark:text-black dark:border-zinc-200 dark:placeholder:text-zinc-700"
                            inputMode="numeric"
                          />
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,2.25fr)_minmax(0,1fr)]">
            <div>
              <Field label="Notas / Observaciones">
                <textarea
                  value={cotizacion.notas}
                  onChange={(e) => setCotizacion((p) => ({ ...p, notas: e.target.value }))}
                  className="min-h-28 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-black outline-none placeholder:text-zinc-700 focus:ring-4 focus:ring-zinc-200 dark:border-zinc-200 dark:bg-white dark:text-black dark:placeholder:text-zinc-500"
                  placeholder="Condiciones, alcance, exclusiones, etc."
                />
              </Field>
            </div>

            <div className="flex justify-end">
              <div className="flex w-full max-w-xs flex-col gap-2 rounded-lg bg-gray-50 p-4 dark:bg-slate-900/50">
                <div className="flex justify-between gap-6 border-b border-gray-200 pb-1 dark:border-slate-600">
                  <span className="font-medium text-gray-600 dark:text-gray-300">Subtotal:</span>
                  <span className="font-bold text-gray-900 tabular-nums dark:text-white">
                    {new Intl.NumberFormat("es-CL", {
                      style: "currency",
                      currency: "CLP",
                      maximumFractionDigits: 0,
                    }).format(totals.subtotal)}
                  </span>
                </div>
                <div className="flex justify-between gap-6 border-b border-gray-200 pb-1 dark:border-slate-600">
                  <span className="font-medium text-gray-600 dark:text-gray-300">IVA (19%):</span>
                  <span className="font-bold text-gray-900 tabular-nums dark:text-white">
                    {new Intl.NumberFormat("es-CL", {
                      style: "currency",
                      currency: "CLP",
                      maximumFractionDigits: 0,
                    }).format(totals.ivaMonto)}
                  </span>
                </div>
                <div className="flex justify-between gap-6 pt-1">
                  <span className="text-lg font-bold text-blue-700 dark:text-blue-400">Total:</span>
                  <span className="text-lg font-extrabold text-blue-900 tabular-nums dark:text-blue-300">
                    {new Intl.NumberFormat("es-CL", {
                      style: "currency",
                      currency: "CLP",
                      maximumFractionDigits: 0,
                    }).format(totals.total)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="mt-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={handleDownloadPdf}
              className="w-full rounded-xl bg-gray-800 px-4 py-3 text-white shadow hover:bg-gray-700 sm:w-auto"
            >
              Descargar PDF
            </button>

            <button
              onClick={handleSave}
              disabled={isSaving}
              className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-zinc-900 px-5 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
            >
              {isSaving ? "Guardando..." : "Guardar en Supabase"}
            </button>
          </div>
        </section>

        {FOOTER_DEVOLUCION_TEXT.trim().length > 0 && (
          <footer className="mt-8 rounded-2xl border border-gray-200 bg-white p-4 text-sm text-zinc-800 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-gray-100">
            <p className="text-center font-semibold leading-relaxed">{FOOTER_DEVOLUCION_TEXT}</p>
          </footer>
        )}

        <style jsx global>{`
          .input {
            height: 44px;
            width: 100%;
            border-radius: 12px;
            border: 1px solid rgb(228 228 231);
            background: white;
            padding: 0 12px;
            font-size: 14px;
            outline: none;
          }
          .input::placeholder {
            color: #555555 !important;
            opacity: 1;
          }
          .dark .input::placeholder {
            color: #9ca3af !important;
            opacity: 1;
          }
          .input:focus {
            box-shadow: 0 0 0 4px rgb(228 228 231);
          }
        `}</style>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1">
      <span className="text-sm font-semibold text-zinc-700 dark:text-gray-100">{label}</span>
      {children}
    </label>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-zinc-600 dark:text-zinc-600">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
