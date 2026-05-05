import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  throw new Error(
    'Worker requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in env. See .env.example.'
  );
}

// Service-role client. Bypasses RLS. Never ship in browser bundles.
export const sb = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
