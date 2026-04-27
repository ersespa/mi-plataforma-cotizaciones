"use client";

import { AuthError, getUser } from "@netlify/identity";
import Image from "next/image";
import { useState } from "react";
import { useNetlifyIdentity } from "@/context/netlify-identity-context";
import CotizacionForm from "./cotizacion-form";

export default function Home() {
  const identity = useNetlifyIdentity();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [signupInfo, setSignupInfo] = useState<string | null>(null);

  if (identity.enabled && !identity.ready) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-gray-50 text-zinc-700 dark:bg-slate-900 dark:text-zinc-200">
        <p className="text-sm font-medium">Comprobando acceso…</p>
      </div>
    );
  }

  if (identity.enabled && identity.ready && !identity.user) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-gray-50 px-6 py-12 text-zinc-900 dark:bg-slate-900 dark:text-white">
        <div className="relative h-20 w-56 shrink-0">
          <Image src="/logo-erse.png" alt="ERSE Electric" fill className="object-contain" priority />
        </div>
        <div className="w-full max-w-sm text-center">
          <h1 className="text-xl font-semibold tracking-tight">Cotizaciones ERSE</h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
            {mode === "login" ? "Inicia sesión para usar el formulario." : "Crea una cuenta (si está permitido en Netlify)."}
          </p>
        </div>

        {identity.initError && (
          <div className="w-full max-w-lg rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-left text-xs text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
            <p className="font-semibold">Aviso al iniciar sesión</p>
            <p className="mt-1 font-mono text-[11px] opacity-90">{identity.initError}</p>
          </div>
        )}

        <div className="flex w-full max-w-sm justify-center gap-2 rounded-xl border border-zinc-200 bg-zinc-100/80 p-1 dark:border-slate-600 dark:bg-slate-800/80">
          <button
            type="button"
            onClick={() => {
              setMode("login");
              setFormError(null);
              setSignupInfo(null);
            }}
            className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition ${
              mode === "login"
                ? "bg-white text-zinc-900 shadow dark:bg-slate-700 dark:text-white"
                : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white"
            }`}
          >
            Entrar
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("signup");
              setFormError(null);
              setSignupInfo(null);
            }}
            className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition ${
              mode === "signup"
                ? "bg-white text-zinc-900 shadow dark:bg-slate-700 dark:text-white"
                : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white"
            }`}
          >
            Registro
          </button>
        </div>

        <form
          className="grid w-full max-w-sm gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setFormError(null);
            setSignupInfo(null);
            setFormBusy(true);
            const run =
              mode === "login"
                ? identity.loginWithPassword(email, password)
                : identity.signupWithPassword(email, password);
            void run
              .then(async () => {
                if (mode === "signup") {
                  const u = await getUser();
                  if (!u) {
                    setSignupInfo(
                      "Si tu sitio exige confirmar el correo, revisa la bandeja de entrada y el enlace de confirmación.",
                    );
                  }
                }
              })
              .catch((err: unknown) => {
                if (err instanceof AuthError) {
                  setFormError(err.message);
                } else if (err instanceof Error) {
                  setFormError(err.message);
                } else {
                  setFormError(String(err));
                }
              })
              .finally(() => setFormBusy(false));
          }}
        >
          <label className="grid gap-1 text-left text-sm font-medium text-zinc-700 dark:text-zinc-200">
            Correo
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-11 rounded-xl border border-zinc-200 bg-white px-3 text-zinc-900 outline-none focus:ring-2 focus:ring-zinc-300 dark:border-slate-600 dark:bg-slate-800 dark:text-white dark:focus:ring-slate-500"
            />
          </label>
          <label className="grid gap-1 text-left text-sm font-medium text-zinc-700 dark:text-zinc-200">
            Contraseña
            <input
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-11 rounded-xl border border-zinc-200 bg-white px-3 text-zinc-900 outline-none focus:ring-2 focus:ring-zinc-300 dark:border-slate-600 dark:bg-slate-800 dark:text-white dark:focus:ring-slate-500"
            />
          </label>
          {formError && (
            <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-left text-xs text-rose-900 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-100">
              {formError}
            </p>
          )}
          {signupInfo && (
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-left text-xs text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-100">
              {signupInfo}
            </p>
          )}
          <button
            type="submit"
            disabled={formBusy}
            className="mt-1 inline-flex h-11 items-center justify-center rounded-xl bg-zinc-900 px-4 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
          >
            {formBusy ? "Procesando…" : mode === "login" ? "Iniciar sesión" : "Crear cuenta"}
          </button>
        </form>

        <p className="max-w-md text-center text-xs text-zinc-500 dark:text-zinc-400">
          Autenticación con{" "}
          <a
            className="underline hover:text-zinc-700 dark:hover:text-zinc-200"
            href="https://docs.netlify.com/manage/security/secure-access-to-sites/identity/get-started/"
            target="_blank"
            rel="noreferrer"
          >
            Netlify Identity
          </a>
          . Si el registro está cerrado, pide una invitación al administrador del sitio.
        </p>
      </div>
    );
  }

  return <CotizacionForm identity={identity} />;
}
