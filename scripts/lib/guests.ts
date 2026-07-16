/**
 * Guest extraction from video title + description.
 *
 * Heuristics won't be perfect — episodes the patterns get wrong are corrected
 * via guest-overrides.json (video_id → guests[]), and episodes with no
 * extracted guest are logged in the ingest summary for manual review.
 */

export interface GuestData {
  name: string;
  linkedin_url: string | null;
  twitter_url: string | null;
  github_url: string | null;
  bluesky_url: string | null;
  website_url: string | null;
  bio: string | null;
}

export interface GuestOverride {
  guests: Array<Partial<GuestData> & { name: string }>;
}

export type GuestOverrides = Record<string, GuestOverride>;

// The host is linked in most descriptions — never record him as a guest.
const HOST_RE = /merill/i;

function emptyGuest(name: string): GuestData {
  return {
    name,
    linkedin_url: null,
    twitter_url: null,
    github_url: null,
    bluesky_url: null,
    website_url: null,
    bio: null,
  };
}

/** Normalised form used to dedupe returning guests across episodes. */
export function normalizeGuestName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Role/title/product words that look like capitalized names but aren't.
// A candidate containing ANY of these is rejected.
const NON_NAME_WORDS = new Set([
  'Microsoft', 'MVP', 'MVPs', 'Entra', 'Azure', 'AD', 'ID', 'Identity', 'Identities',
  'Security', 'Senior', 'Junior', 'Director', 'Principal', 'Architect', 'Engineer',
  'Researcher', 'Research', 'Consultant', 'Manager', 'Lead', 'PM', 'Product',
  'Program', 'Cloud', 'Conditional', 'Access', 'Agent', 'Agents', 'Copilot',
  'Global', 'Secure', 'Information', 'The', 'This', 'That', 'Episode', 'Chat',
  'Podcast', 'Show', 'Active', 'Directory', 'Governance', 'Authentication',
  'Protection', 'Team', 'Stack', 'Veteran', 'Expert', 'Core', 'Maintainer',
  'Passkey', 'Passkeys', 'Maester', 'Defender', 'Windows', 'Office', 'Graph',
  'Ignite', 'General', 'Availability', 'Insight', 'Football', 'Giants',
  'App', 'Apps', 'Roles', 'Role', 'Logic', 'Architecture', 'World', 'Inside',
  'Tenant', 'Hidden', 'Your', 'We', 'Are', 'IT', 'AI', 'Zero', 'Trust',
  'External', 'Private', 'Hybrid', 'Join', 'Sync', 'Connect', 'Kerberos',
  'Story', 'Secrets', 'Secret', 'Deep', 'Dive', 'Creator', 'Creators',
  'Elkjøp', 'Nordic', 'IKEA', 'Alaska', 'UK', 'Denmark', 'Melbourne',
  'Experts', 'Live', 'Customer', 'Experience', 'CxE', 'Head', 'Owner',
  'Midnight', 'Blizzard', 'Patriot', 'Consulting', 'Proximus', 'NXT',
]);

/** True when s looks like a person's name: 2–3 capitalized words, none a role word. */
function isPersonName(s: string): boolean {
  const words = s.trim().split(/\s+/);
  if (words.length < 2 || words.length > 3) return false;
  return words.every((w) => {
    if (!/^[A-ZÀ-Þ][A-Za-zÀ-ÿ.'’-]+$/.test(w)) return false;
    const stem = w.replace(/['’]s$/i, '').replace(/[.'’-]+$/, '');
    return !NON_NAME_WORDS.has(stem);
  });
}

/**
 * All person-name-looking word pairs/triples inside a text fragment.
 * Capitalized runs can embed role prefixes ("Microsoft PM Jordan Gross"), so
 * each run is scanned from the end — names come last in English apposition.
 */
function personNamesIn(fragment: string): string[] {
  const runs = fragment.match(/[A-ZÀ-Þ][A-Za-zÀ-ÿ.'’-]+(?:\s+[A-ZÀ-Þ][A-Za-zÀ-ÿ.'’-]+)+/g) ?? [];
  const names: string[] = [];
  for (const run of runs) {
    const words = run.split(/\s+/);
    for (const size of [3, 2]) {
      if (words.length < size) continue;
      const tail = words.slice(-size).join(' ');
      if (isPersonName(tail) && !HOST_RE.test(tail)) {
        names.push(tail);
        break;
      }
    }
  }
  return names;
}

function extractNamesFromTitle(title: string): string[] {
  // "Entra.Chat #12 with Jane Doe", "... ft. Jane Doe", "... with it's creator Kuba Gretzky"
  const withMatch = title.match(
    /(?:\bwith\b|\bw\/|\bft\.?(?=\s)|\bfeat\.?(?=\s)|\bfeaturing\b)\s*:?\s*([^|#()[\]]+)/i
  );
  if (!withMatch) return [];
  return personNamesIn(withMatch[1].replace(/[-–—].*$/, ''));

  // NOTE: a title-possessive pattern ("Vince Smith's Microsoft Story") was
  // tried and dropped — Title Case makes any phrase look like a name
  // ("Find Your Tenant's Hidden Flaws"). Those episodes go via overrides.
}

interface DescriptionGuess {
  names: string[];
  bio: string | null;
}

/**
 * Episode descriptions introduce guests in several recurring shapes:
 *  - "Merill speaks/sits down with Katie Knowles, Senior Security Researcher at Datadog, about ..."
 *  - "Merill is joined by Microsoft MVP and Maester core maintainer Sam Erde, to break down ..."
 *  - "Per Torben joins the show to share ..." / "Emilien Socchi, ..., joins us to discuss ..."
 *  - "Christina Morillo, Senior Director of ..., shares her ..."
 * Extract the name(s) and, when there is a single guest, the role/company
 * segment as a short bio.
 */
function extractFromDescription(description: string): DescriptionGuess {
  const names: string[] = [];
  let bio: string | null = null;

  const recordBio = (segment: string | undefined): void => {
    const cleaned = (segment ?? '').replace(/[\s,]+$/, '').trim();
    if (!bio && cleaned.length >= 5 && cleaned.length <= 120 && !isPersonName(cleaned)) {
      bio = cleaned;
    }
  };

  // 1. "speaks/spoke/chats/talks/sits down/catches up/conversation with <names[, role]>"
  const speaksWith = description.match(
    /\b(?:speaks?|spoke|chats?|talks?|sits?\s+down|catches?\s+up|conversation)\s+with\s+([^.\n]{3,160}?)(?:\s+about\b|,?\s+to\s+\w|,?\s+as\s+\w|,?\s+who\s+\w|\.|\n|$)/i
  );
  if (speaksWith) {
    const segments = speaksWith[1].split(',');
    names.push(...personNamesIn(speaksWith[1]));
    recordBio(segments.slice(1).join(', '));
  }

  // 2. "is joined by <titles and Name> ..." / "joining me are <names>" — names
  // live in the first ~110 chars; no terminator required (role clauses run long)
  const joinedBy = description.match(
    /\b(?:join(?:ed|s)?\s+by|joining\s+(?:me|us|Merill)\s+(?:are|is|today\s+(?:are|is)))\s+([^.\n]{3,110})/i
  );
  if (joinedBy) {
    names.push(...personNamesIn(joinedBy[1]));
  }

  // 3. "<Name>[, role,][ from <org>] joins the show/podcast/us/me/Merill/Entra Chat/to discuss"
  const joinsRe =
    /([A-ZÀ-Þ][A-Za-zÀ-ÿ.'’-]+(?:\s+[A-ZÀ-Þ][A-Za-zÀ-ÿ.'’-]+){1,2})(?:,\s*([^,.\n]{3,120}?),)?(?:\s+from\s+[^,.\n]{2,60}?)?\s+joins?\s+(?:the\s+(?:podcast|show|conversation)|us|me|Merill|Entra\.?\s?Chat|to\s+\w+)/g;
  let joinsMatch: RegExpExecArray | null;
  while ((joinsMatch = joinsRe.exec(description)) !== null) {
    // The greedy capture can swallow role words ("Senior Architect Per
    // Torben") — personNamesIn scans the run from the end
    const found = personNamesIn(joinsMatch[1]);
    if (found.length > 0) {
      names.push(...found);
      recordBio(joinsMatch[2]);
    }
  }

  // 4. "<Name>, <role>, shares/reveals/explains/..." (guest-led descriptions)
  const nameRoleVerb = description.match(
    /([A-ZÀ-Þ][A-Za-zÀ-ÿ.'’-]+\s+[A-ZÀ-Þ][A-Za-zÀ-ÿ.'’-]+),\s*([^,.\n]{3,120}?),?\s+(?:shares|reveals|explains|discusses|walks|breaks|unpacks|shows|dives|demystifies)/
  );
  if (nameRoleVerb && isPersonName(nameRoleVerb[1]) && !HOST_RE.test(nameRoleVerb[1])) {
    names.push(nameRoleVerb[1]);
    recordBio(nameRoleVerb[2]);
  }

  // 5. Description opens with the guest names: "Michael Brunker and Prem
  // Kothandapani share their extensive experience ..."
  const leading = description.match(
    /^([^.\n]{5,120}?)\s+(?:shares?|discuss(?:es)?|joins?|reveals?|unpacks?|takes?\s+us)\b/
  );
  if (leading) {
    names.push(...personNamesIn(leading[1]));
  }

  // 6. "This episode features Anju Singh, a Product Manager ..."
  const features = description.match(/\bfeatures\s+([^.\n]{3,110})/i);
  if (features) {
    const segments = features[1].split(',');
    names.push(...personNamesIn(segments[0]));
    recordBio(segments.slice(1).join(', '));
  }

  // 7. Panel bullets: "🎙️ Tarek Dawoud: Lead Architect ..." (one per panelist)
  const panelRe = /🎙️?\s*([A-ZÀ-Þ][A-Za-zÀ-ÿ.'’-]+(?:\s+[A-ZÀ-Þ][A-Za-zÀ-ÿ.'’-]+){1,2}):/gu;
  let panelMatch: RegExpExecArray | null;
  while ((panelMatch = panelRe.exec(description)) !== null) {
    if (isPersonName(panelMatch[1]) && !HOST_RE.test(panelMatch[1])) {
      names.push(panelMatch[1]);
    }
  }

  return { names, bio };
}

function firstMatch(text: string, re: RegExp): string | null {
  const m = text.match(re);
  if (!m) return null;
  const url = m[0].replace(/[.,;)\]]+$/, '');
  return HOST_RE.test(url) ? null : url;
}

function extractLinks(description: string): Omit<GuestData, 'name' | 'bio' | 'website_url'> & { website_url: null } {
  return {
    linkedin_url: firstMatch(
      description,
      /https?:\/\/(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]+\/?/i
    ),
    twitter_url: firstMatch(
      description,
      /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/(?!intent|search|hashtag|share|home)[A-Za-z0-9_]+\/?(?=[\s"']|$)/i
    ),
    github_url: firstMatch(
      description,
      /https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9-]+\/?(?=[\s"']|$)/i
    ),
    bluesky_url: firstMatch(
      description,
      /https?:\/\/bsky\.app\/profile\/[A-Za-z0-9.\-_]+/i
    ),
    // Descriptions are full of sponsor/newsletter links — auto-detecting a
    // guest's personal site is too noisy. Set via guest-overrides.json.
    website_url: null,
  };
}

export function extractGuests(
  videoId: string,
  title: string,
  description: string | null,
  overrides: GuestOverrides
): GuestData[] {
  const override = overrides[videoId];
  if (override) {
    return override.guests.map((g) => ({ ...emptyGuest(g.name), ...g }));
  }

  // Names can come from the title ("... with Jane Doe") or the description
  // ("Merill speaks with Jane Doe, Principal PM at ..."). Merge and dedupe.
  const titleNames = extractNamesFromTitle(title);
  const fromDescription = description
    ? extractFromDescription(description)
    : { names: [], bio: null };

  const seen = new Set<string>();
  const names: string[] = [];
  for (const n of [...titleNames, ...fromDescription.names]) {
    const key = normalizeGuestName(n);
    if (!seen.has(key)) {
      seen.add(key);
      names.push(n);
    }
  }
  if (names.length === 0) return [];

  // Profile links can only be attributed confidently when there is exactly
  // one guest; multi-guest episodes get links via overrides.
  if (names.length === 1 && description) {
    return [{ ...emptyGuest(names[0]), ...extractLinks(description), bio: fromDescription.bio }];
  }

  return names.map(emptyGuest);
}
