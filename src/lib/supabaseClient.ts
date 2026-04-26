import { createClient } from "@supabase/supabase-js";

let cached:
  | ReturnType<typeof createClient>
  | null = null;

export function getSupabaseClient() {
  if (cached) return cached;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY. Create .env.local (see .env.example).",
    );
  }

  cached = createClient(supabaseUrl, supabaseAnonKey);
  return cached;
}

