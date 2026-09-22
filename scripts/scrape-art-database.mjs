import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUTPUT_PATH = path.join(ROOT, "art_database.json");
const LOCAL_HTML_DIR = path.join(ROOT, "scripts", "html");

const SOURCES = [
  {
    collection: "Modern and Contemporary art",
    url: "https://www.pkb.ch/en/art-pkb/modern-and-contemporary-art/",
    localFile: "modern-and-contemporary-art.html",
  },
  {
    collection: "Renaissance art",
    url: "https://www.pkb.ch/en/art-pkb/reinassance-art-collection/",
    localFile: "reinassance-art-collection.html",
  },
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const YEAR_PATTERN =
  /^(circa\s+)?\d{2,4}(\s*[–\-/]\s*\d{2,4})?(\s+circa)?$|^\d{4}\s+\d{2,4}$/i;

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function firstSrcsetUrl(srcset) {
  if (!srcset) return null;
  const first = srcset.split(",")[0]?.trim();
  if (!first) return null;
  return first.split(/\s+/)[0] || null;
}

function toFullSizeWordPressUrl(url) {
  if (!url) return url;
  return url.replace(/-\d+x\d+(?=\.(?:jpe?g|png|webp|gif)$)/i, "");
}

function pickImageUrl(card) {
  const source = card.find("picture source").first();
  const img = card.find("picture img, .art-listed-image img").first();
  const candidates = [
    firstSrcsetUrl(source.attr("data-srcset")),
    firstSrcsetUrl(source.attr("srcset")),
    img.attr("data-src"),
    img.attr("src"),
    img.attr("data-lazy-src"),
  ];

  const url = candidates.find(
    (candidate) =>
      typeof candidate === "string" &&
      candidate.startsWith("http") &&
      !candidate.startsWith("data:")
  );

  return url ? toFullSizeWordPressUrl(url) : null;
}

function splitArtistAndTitle(text) {
  const commaIndex = text.indexOf(",");
  if (commaIndex > 0) {
    const artist = normalizeWhitespace(text.slice(0, commaIndex));
    const title = normalizeWhitespace(text.slice(commaIndex + 1));
    if (artist && title) return { artist, title };
  }
  return { artist: text, title: "Untitled" };
}

function parseCaption(rawCaption) {
  const caption = normalizeWhitespace(rawCaption);
  if (!caption) {
    return { artist: "Unknown artist", title: "Untitled", year: null };
  }

  const dashParts = caption.split(/\s+[-–—]\s+/).map(normalizeWhitespace).filter(Boolean);
  let year = null;
  let remainder = dashParts;

  if (remainder.length > 1 && YEAR_PATTERN.test(remainder[remainder.length - 1])) {
    year = remainder[remainder.length - 1];
    remainder = remainder.slice(0, -1);
  }

  if (remainder.length >= 2) {
    return {
      artist: remainder[0],
      title: remainder.slice(1).join(" - "),
      year,
    };
  }

  const { artist, title } = splitArtistAndTitle(remainder[0] || caption);
  return { artist, title, year };
}

function parseArtworks(html, source) {
  const $ = cheerio.load(html);
  const items = [];

  $(".flex-hold-child").each((_, element) => {
    const card = $(element);
    if (!card.find(".art-listed-image").length) return;

    const caption = card.find("h6").first().text();
    const imageUrl = pickImageUrl(card);
    if (!imageUrl) return;

    const { artist, title, year } = parseCaption(caption);
    items.push({
      artist,
      title,
      imageUrl,
      ...(year ? { year } : {}),
      collection: source.collection,
      sourceUrl: source.url,
    });
  });

  return items;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.artist}|${item.title}|${item.imageUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadHtml(source) {
  const localPath = path.join(LOCAL_HTML_DIR, source.localFile);

  try {
    const response = await fetch(source.url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    console.log(`Fetched ${source.url}`);
    return html;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`Remote fetch failed for ${source.url} (${reason}). Trying local HTML…`);

    try {
      const html = await readFile(localPath, "utf8");
      console.log(`Loaded local file ${localPath}`);
      return html;
    } catch {
      throw new Error(
        `Could not scrape ${source.url} and local fallback is missing: ${localPath}. Save the page HTML there and retry.`
      );
    }
  }
}

async function main() {
  await mkdir(LOCAL_HTML_DIR, { recursive: true });

  const collected = [];
  for (const source of SOURCES) {
    const html = await loadHtml(source);
    const artworks = parseArtworks(html, source);
    console.log(`${source.collection}: ${artworks.length} artworks`);
    collected.push(...artworks);
  }

  const database = dedupe(collected);
  await writeFile(OUTPUT_PATH, `${JSON.stringify(database, null, 2)}\n`, "utf8");
  console.log(`Wrote ${database.length} artworks to ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
