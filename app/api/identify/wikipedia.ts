const OPENSEARCH_ENDPOINT = "https://en.wikipedia.org/w/api.php";
const SUMMARY_ENDPOINT = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const REQUEST_TIMEOUT_MS = 5000;
const USER_AGENT = "ArtScanner/1.0 (artwork lookup demo)";

/** Catalogue placeholders that would only ever match unrelated Wikipedia pages. */
const GENERIC_TERMS = new Set(["untitled", "senza titolo", "no title", "unknown artist"]);

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(" ")
    .filter((token) => token.length > 2);
}

async function getJson<T>(url: URL): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    // Wikipedia is an enrichment step: a failure must never break the identification.
    return null;
  }
}

/**
 * The catalogue stores many artists as "Surname Firstname", while Wikipedia
 * titles them "Firstname Surname", so a reversed variant is tried as well.
 */
function searchVariants(term: string): string[] {
  const words = term.split(/\s+/).filter(Boolean);
  if (words.length !== 2) return [term];
  return [term, `${words[1]} ${words[0]}`];
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(substitution, previous[j] + 1, current[j - 1] + 1);
    }
    previous = current;
  }

  return previous[b.length];
}

function matchesToken(token: string, candidateTokens: Set<string>, allowFuzzy: boolean): boolean {
  if (candidateTokens.has(token)) return true;
  // Catalogue spellings differ from Wikipedia by a letter now and then (Giovenone/Giovanone).
  if (!allowFuzzy || token.length < 6) return false;

  for (const candidate of candidateTokens) {
    if (Math.abs(candidate.length - token.length) <= 1 && editDistance(token, candidate) <= 1) {
      return true;
    }
  }

  return false;
}

function numbersIn(value: string): string[] {
  return normalize(value).match(/\d+/g) ?? [];
}

/** Guards against linking a loosely related page returned by the search endpoint. */
function isRelevant(term: string, candidate: string): boolean {
  const withoutQualifier = candidate.replace(/\s*\([^)]*\)\s*$/, "");

  // Series numbers matter: "Mediterraneo 7" is not the page "Mediterraneo".
  const candidateNumbers = new Set(numbersIn(withoutQualifier));
  if (numbersIn(term).some((number) => !candidateNumbers.has(number))) return false;

  if (normalize(term) === normalize(withoutQualifier)) return true;

  const termTokens = tokenize(term);
  if (termTokens.length === 0) return false;

  const candidateTokens = new Set(tokenize(withoutQualifier));
  // A page carrying extra words describes a broader subject, not this artist or artwork.
  if (candidateTokens.size > termTokens.length + 1) return false;

  // A single word is too little evidence to accept an approximate spelling.
  const allowFuzzy = termTokens.length > 1;
  return termTokens.every((token) => matchesToken(token, candidateTokens, allowFuzzy));
}

async function searchTitles(query: string): Promise<string[]> {
  const url = new URL(OPENSEARCH_ENDPOINT);
  url.searchParams.set("action", "opensearch");
  url.searchParams.set("search", query);
  url.searchParams.set("limit", "3");
  url.searchParams.set("namespace", "0");
  url.searchParams.set("format", "json");

  const payload = await getJson<[string, string[], string[], string[]]>(url);
  return payload?.[1] ?? [];
}

async function resolvePageUrl(title: string): Promise<string | null> {
  const url = new URL(SUMMARY_ENDPOINT + encodeURIComponent(title.replace(/ /g, "_")));
  const payload = await getJson<{
    type?: string;
    content_urls?: { desktop?: { page?: string } };
  }>(url);

  // Disambiguation and redirect stubs are not useful destinations for the user.
  if (payload?.type !== "standard") return null;
  return payload.content_urls?.desktop?.page ?? null;
}

/**
 * Returns the English Wikipedia URL for an artist or title, or null when there is no
 * confident match. `minTokens` raises the bar for artwork titles, where a single common
 * word ("Ala", "Gigante") would otherwise match an unrelated page.
 */
export async function findWikipediaUrl(
  term: string,
  { minTokens = 1 }: { minTokens?: number } = {}
): Promise<string | null> {
  const trimmed = term.trim();
  if (!trimmed || GENERIC_TERMS.has(normalize(trimmed)) || tokenize(trimmed).length < minTokens) {
    return null;
  }

  for (const query of searchVariants(trimmed)) {
    for (const candidate of await searchTitles(query)) {
      if (!isRelevant(trimmed, candidate)) continue;

      const url = await resolvePageUrl(candidate);
      if (url) return url;
    }
  }

  return null;
}
