"use client";

import {
  getSettings,
  getUser,
  handleAuthCallback,
  login as identityLogin,
  logout as identityLogout,
  onAuthChange,
  signup as identitySignup,
  AuthError,
  MissingIdentityError,
  type User,
} from "@netlify/identity";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type { User as NetlifyIdentityUser };

export type NetlifyIdentityContextValue = {
  enabled: boolean;
  ready: boolean;
  user: User | null;
  initError: string | null;
  loginWithPassword: (email: string, password: string) => Promise<void>;
  signupWithPassword: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const NetlifyIdentityContext = createContext<NetlifyIdentityContextValue | null>(null);

const BOOTSTRAP_TIMEOUT_MS = 14_000;

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: tiempo agotado (${Math.round(ms / 1000)} s)`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isLocalDevHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "0.0.0.0" ||
    hostname.endsWith(".local")
  );
}

/** Red privada típica (otro PC / móvil abriendo http://192.168.x.x:3000). */
function isPrivateLanIPv4(hostname: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (![a, b, Number(m[3]), Number(m[4])].every((n) => n >= 0 && n <= 255)) return false;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 127) return true;
  return false;
}

function readIdentityOff(): boolean {
  return (
    (process.env.NEXT_PUBLIC_NETLIFY_IDENTITY_OFF ?? "").toLowerCase() === "true" ||
    process.env.NEXT_PUBLIC_NETLIFY_IDENTITY_OFF === "1"
  );
}

function readForceIdentityInDev(): boolean {
  const v = (process.env.NEXT_PUBLIC_NETLIFY_IDENTITY_DEV ?? "").toLowerCase();
  return v === "1" || v === "true";
}

/**
 * Identity solo en despliegue (producción). En `next dev` y en hosts locales / LAN
 * privada no se pide login para poder abrir el formulario como antes.
 */
function shouldEnableIdentityInBrowser(): boolean {
  if (typeof window === "undefined") return false;
  if (readIdentityOff() || window.location.protocol === "file:") return false;

  const host = window.location.hostname;
  if (process.env.NODE_ENV === "development" && !readForceIdentityInDev()) {
    return false;
  }
  if (isLocalDevHost(host) || isPrivateLanIPv4(host)) {
    return false;
  }

  return true;
}

export function NetlifyIdentityProvider({ children }: { children: ReactNode }) {
  const [enabled] = useState(() => shouldEnableIdentityInBrowser());
  const [ready, setReady] = useState(() => !shouldEnableIdentityInBrowser());
  const [user, setUser] = useState<User | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    (async () => {
      setReady(false);
      setInitError(null);

      try {
        try {
          await withTimeout(handleAuthCallback(), BOOTSTRAP_TIMEOUT_MS, "Identity (callback)");
        } catch (e) {
          if (!cancelled) {
            const msg = e instanceof AuthError ? e.message : e instanceof Error ? e.message : String(e);
            setInitError(msg);
          }
        }

        if (cancelled) return;

        try {
          await withTimeout(getSettings(), BOOTSTRAP_TIMEOUT_MS, "Identity (settings)");
        } catch (e) {
          if (!cancelled) {
            if (e instanceof MissingIdentityError) {
              setInitError(
                "Netlify Identity no está disponible en esta URL. Activa Identity en el sitio (Project configuration → Identity) y vuelve a desplegar.",
              );
            } else if (e instanceof AuthError) {
              setInitError(e.message);
            } else {
              setInitError(e instanceof Error ? e.message : String(e));
            }
          }
        }

        if (cancelled) return;
        const u = await withTimeout(getUser(), BOOTSTRAP_TIMEOUT_MS, "Identity (sesión)");
        if (!cancelled) setUser(u);
      } catch (e) {
        if (!cancelled) {
          setInitError(e instanceof Error ? e.message : String(e));
        }
      }

      if (cancelled) return;

      unsubscribe = onAuthChange((_event, next) => {
        setUser(next);
      });
    })()
      .finally(() => {
        if (!cancelled) setReady(true);
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [enabled]);

  const loginWithPassword = useCallback(async (email: string, password: string) => {
    await identityLogin(email.trim(), password);
    const u = await getUser();
    setUser(u);
  }, []);

  const signupWithPassword = useCallback(async (email: string, password: string) => {
    await identitySignup(email.trim(), password);
    const u = await getUser();
    setUser(u);
  }, []);

  const logout = useCallback(async () => {
    if (!enabled) return;
    try {
      await identityLogout();
    } finally {
      setUser(null);
    }
  }, [enabled]);

  const value = useMemo(
    () => ({
      enabled,
      ready,
      user,
      initError,
      loginWithPassword,
      signupWithPassword,
      logout,
    }),
    [enabled, ready, user, initError, loginWithPassword, signupWithPassword, logout],
  );

  return <NetlifyIdentityContext.Provider value={value}>{children}</NetlifyIdentityContext.Provider>;
}

export function useNetlifyIdentity(): NetlifyIdentityContextValue {
  const ctx = useContext(NetlifyIdentityContext);
  if (!ctx) {
    throw new Error("useNetlifyIdentity must be used within NetlifyIdentityProvider");
  }
  return ctx;
}
