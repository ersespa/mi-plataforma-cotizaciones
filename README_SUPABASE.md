# Supabase (ERSE) - Configuración rápida

## 1) Variables de entorno

Crea el archivo `.env.local` en la raíz del proyecto (no se commitea) copiando desde `.env.example`:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

## 2) Tabla `cotizaciones`

El formulario hace un `insert` a la tabla `cotizaciones`.

Por defecto, el código intenta insertar estas columnas:

- `numero` (text, nullable)
- `fecha` (date)
- `cliente_nombre` (text)
- `cliente_rut` (text, nullable)
- `cliente_email` (text, nullable)
- `cliente_telefono` (text, nullable)
- `cliente_direccion` (text, nullable)
- `atencion` (text, nullable)
- `moneda` (text)
- `items` (jsonb)
- `subtotal` (numeric)
- `descuento` (numeric)
- `neto` (numeric)
- `iva` (numeric)
- `total` (numeric)
- `notas` (text, nullable)
- `payload` (jsonb) — copia completa del formulario

Si tu tabla tiene un esquema distinto, puedes:

- Ajustar el esquema (recomendado), o
- Cambiar el mapeo del objeto `row` en `src/app/page.tsx`.

### SQL sugerido (si necesitas crear/ajustar la tabla)

```sql
create table if not exists public.cotizaciones (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  numero text,
  fecha date not null,
  cliente_nombre text not null,
  cliente_rut text,
  cliente_email text,
  cliente_telefono text,
  cliente_direccion text,
  atencion text,
  moneda text not null default 'CLP',
  items jsonb not null default '[]'::jsonb,
  subtotal numeric not null default 0,
  descuento numeric not null default 0,
  neto numeric not null default 0,
  iva numeric not null default 0,
  total numeric not null default 0,
  notas text,
  payload jsonb
);
```

## 3) RLS (Row Level Security)

Si vas a guardar desde el navegador usando `anon key`, necesitas una política que permita `insert`.
Ejemplo mínimo (ajusta según tu seguridad):

```sql
alter table public.cotizaciones enable row level security;

create policy "allow insert cotizaciones"
on public.cotizaciones
for insert
to anon
with check (true);
```

