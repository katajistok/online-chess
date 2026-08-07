// Supabase project connection details.
// The publishable (formerly "anon") key is meant to be public - it's safe to
// commit and ship in client-side code. Access control lives in the RLS
// policies in supabase/schema.sql, not in keeping this key secret.
//
// Never put the "service_role" / "secret" key here or in any client code -
// that one bypasses Row Level Security entirely.

export const SUPABASE_URL = "https://ulewbiwfvvhigxpuvqss.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_rAM-oAxs-_XOp7_OaKHKFA_1axig43n";
