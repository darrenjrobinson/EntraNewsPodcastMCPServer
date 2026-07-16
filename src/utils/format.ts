/** Shared output formatting helpers for tool handlers. */

/** Seconds → "42:10" or "1:02:45". */
export function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * YouTube deep link that starts playback at the given offset.
 * Uses the youtu.be short form (like YouTube's own Share button) because it
 * needs no '&' — markdown/HTML renderers that escape '&' to '&amp;' were
 * breaking the t parameter on watch?v=...&t=... style links.
 */
export function deepLink(videoId: string, startTime: number | null): string {
  const base = `https://youtu.be/${videoId}`;
  return startTime != null && startTime > 0 ? `${base}?t=${Math.floor(startTime)}` : base;
}

export function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/** Guest profile links as a single "LinkedIn: … · GitHub: …" style line. */
export function formatGuestLinks(g: {
  linkedin_url: string | null;
  twitter_url: string | null;
  github_url: string | null;
  bluesky_url: string | null;
  website_url: string | null;
}): string {
  const links: string[] = [];
  if (g.linkedin_url) links.push(`LinkedIn: ${g.linkedin_url}`);
  if (g.twitter_url) links.push(`Twitter/X: ${g.twitter_url}`);
  if (g.github_url) links.push(`GitHub: ${g.github_url}`);
  if (g.bluesky_url) links.push(`Bluesky: ${g.bluesky_url}`);
  if (g.website_url) links.push(`Web: ${g.website_url}`);
  return links.join(' · ');
}
