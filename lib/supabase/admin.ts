import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getPublicEnv, getServerEnv } from "@/lib/env";

/**
 * Service-role client. Bypasses RLS — use ONLY on the server, after an explicit
 * authorization check, and always filter by organization_id. Never import this
 * from a client component (the key is not NEXT_PUBLIC_ and would be undefined anyway).
 */
let cached: SupabaseClient | null = null;

export function createAdminClient(): SupabaseClient {
  if (typeof window !== "undefined") throw new Error("The admin client must never run in the browser.");
  if (cached) return cached;
  const { NEXT_PUBLIC_SUPABASE_URL } = getPublicEnv();
  const { SUPABASE_SERVICE_ROLE_KEY } = getServerEnv();
  cached = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return cached;
}
