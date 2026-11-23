export function getSupabaseProjectRef(connectionString: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("Invalid database URL; unable to verify Supabase project identity.");
  }

  const host = parsed.hostname.toLowerCase();
  const directMatch = host.match(/^db\.([a-z0-9]{20})\.supabase\.co$/);
  if (directMatch?.[1]) return directMatch[1];

  if (host.endsWith(".pooler.supabase.com")) {
    // Supavisor pooler usernames use <database-user>.<project-ref>.
    const username = decodeURIComponent(parsed.username);
    const poolerMatch = username.match(/\.([a-z0-9]{20})$/i);
    if (poolerMatch?.[1]) return poolerMatch[1].toLowerCase();
  }

  return null;
}
