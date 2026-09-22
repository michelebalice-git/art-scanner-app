"use strict";

/**
 * Rebuilds the artwork catalogue used by the recognition API.
 *
 * Scrapes both PKB collection pages, downloads every artwork image and stores two
 * visual fingerprints next to the metadata:
 *
 *   - a CLIP embedding, which survives the crop, tilt and lighting of a real photo
 *     and drives the actual matching;
 *   - a blockhash, which is nearly free and flags a pixel-identical reproduction.
 *
 * Embeddings are quantized to one byte per dimension, keeping the committed file at a
 * few hundred kilobytes instead of a few megabytes.
 *
 * The output carries no generation timestamp on purpose: the daily workflow commits it
 * only when the content really changed, and a timestamp would change on every run.
 */

const { mkdir, readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");

const { bmvbhash } = require("blockhash-core");
const cheerio = require("cheerio");
const {
  AutoProcessor,
  CLIPVisionModelWithProjection,
  RawImage,
  env,
} = require("@huggingface/transformers");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT_PATH = path.join(ROOT, "public", "data", "art_catalog.json");
const LOCAL_HTML_DIR = path.join(ROOT, "scripts", "html");

const EMBEDDING_MODEL = "Xenova/clip-vit-base-patch32";
/** 16 blocks per side produces a 256-bit hash, written as 64 hex characters. */
const HASH_BITS = 16;
const HASH_IMAGE_SIZE = 256;
const DOWNLOAD_CONCURRENCY = 8;
const DOWNLOAD_RETRIES = 2;
/** A scrape that loses more than a fifth of the catalogue is treated as a failure. */
const MIN_CATALOG_RATIO = 0.8;

env.allowLocalModels = false;
env.cacheDir = path.join(ROOT, ".cache", "transformers");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

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

const YEAR_PATTERN =
  /^(circa\s+)?\d{2,4}(\s*[–\-/]\s*\d{2,4})?(\s+circa)?$|^\d{4}\s+\d{2,4}$/i;

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function firstSrcsetUrl(srcset) {
  if (!srcset) return null;
  const first = srcset.split(",")[0];
  if (!first) return null;
  const url = first.trim().split(/\s+/)[0];
  return url && url.startsWith("http") ? url : null;
}

function toFullSizeUrl(url) {
  return url.replace(/-\d+x\d+(?=\.(?:jpe?g|png|webp|gif)$)/i, "");
}

/**
 * The listing markup holds a 600px variant in the srcset and a 10px placeholder in the
 * `img` tag. The variant is enough for both fingerprints; the full size one is what the
 * UI displays.
 */
function pickImageUrls(card) {
  const source = card.find("picture source").first();
  const img = card.find("picture img, .art-listed-image img").first();

  const variant =
    firstSrcsetUrl(source.attr("data-srcset")) || firstSrcsetUrl(source.attr("srcset"));
  const fallback = [img.attr("data-src"), img.attr("src")].find(
    (value) => typeof value === "string" && value.startsWith("http")
  );

  const reference = variant || fallback;
  if (!reference) return null;

  return {
    imageUrl: toFullSizeUrl(reference),
    fingerprintUrl: variant || toFullSizeUrl(reference),
  };
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
  if (!caption) return { artist: "Unknown artist", title: "Untitled", year: null };

  const parts = caption.split(/\s+[-–—]\s+/).map(normalizeWhitespace).filter(Boolean);
  let year = null;
  let remainder = parts;

  if (remainder.length > 1 && YEAR_PATTERN.test(remainder[remainder.length - 1])) {
    year = remainder[remainder.length - 1];
    remainder = remainder.slice(0, -1);
  }

  if (remainder.length >= 2) {
    return { artist: remainder[0], title: remainder.slice(1).join(" - "), year };
  }

  const { artist, title } = splitArtistAndTitle(remainder[0] || caption);
  return { artist, title, year };
}

function idFromUrl(url) {
  const filename = decodeURIComponent(url.split("/").pop() || "");
  return filename
    .replace(/\.(jpe?g|png|webp|gif)$/i, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function parseArtworks(html, source) {
  const $ = cheerio.load(html);
  const items = [];

  $(".flex-hold-child").each((_, element) => {
    const card = $(element);
    if (!card.find(".art-listed-image").length) return;

    const urls = pickImageUrls(card);
    if (!urls) return;

    const { artist, title, year } = parseCaption(card.find("h6").first().text());
    items.push({
      id: idFromUrl(urls.imageUrl),
      artist,
      title,
      ...(year ? { year } : {}),
      collection: source.collection,
      imageUrl: urls.imageUrl,
      sourceUrl: source.url,
      fingerprintUrl: urls.fingerprintUrl,
    });
  });

  return items;
}

async function loadHtml(source) {
  try {
    const response = await fetch(source.url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

    console.log(`Fetched ${source.url}`);
    return await response.text();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`Remote fetch failed for ${source.url} (${reason}). Trying local HTML...`);

    const localPath = path.join(LOCAL_HTML_DIR, source.localFile);
    try {
      const html = await readFile(localPath, "utf8");
      console.log(`Loaded local file ${localPath}`);
      return html;
    } catch {
      throw new Error(
        `Could not scrape ${source.url} and local fallback is missing: ${localPath}`
      );
    }
  }
}

async function downloadImage(url) {
  let lastError = null;

  for (let attempt = 0; attempt <= DOWNLOAD_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "image/*" },
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.blob();
    } catch (error) {
      lastError = error;
      if (attempt < DOWNLOAD_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * One byte per dimension. The scale is stored alongside so the API can rebuild a vector
 * close enough to the original that cosine similarity is unaffected.
 */
function quantize(vector) {
  let maxAbs = 0;
  for (const value of vector) maxAbs = Math.max(maxAbs, Math.abs(value));

  const scale = maxAbs / 127 || 1;
  const bytes = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) {
    bytes[i] = Math.max(-127, Math.min(127, Math.round(vector[i] / scale)));
  }

  return {
    embedding: Buffer.from(bytes.buffer).toString("base64"),
    embeddingScale: Number(scale.toPrecision(8)),
  };
}

async function main() {
  const scraped = [];
  for (const source of SOURCES) {
    const html = await loadHtml(source);
    const artworks = parseArtworks(html, source);
    console.log(`${source.collection}: ${artworks.length} artworks found`);
    scraped.push(...artworks);
  }

  const unique = [];
  const seenImages = new Set();
  const usedIds = new Set();

  for (const artwork of scraped) {
    if (seenImages.has(artwork.imageUrl)) continue;
    seenImages.add(artwork.imageUrl);

    let id = artwork.id || `artwork-${unique.length}`;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${artwork.id}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);

    unique.push({ ...artwork, id });
  }

  console.log(`Loading ${EMBEDDING_MODEL}...`);
  const processor = await AutoProcessor.from_pretrained(EMBEDDING_MODEL);
  // The 8-bit weights keep the download small and cost roughly nothing in accuracy.
  const model = await CLIPVisionModelWithProjection.from_pretrained(EMBEDDING_MODEL, {
    dtype: "q8",
  });

  console.log(`Fingerprinting ${unique.length} images...`);

  const failures = [];
  const images = await mapWithConcurrency(unique, DOWNLOAD_CONCURRENCY, async (artwork) => {
    try {
      const blob = await downloadImage(artwork.fingerprintUrl);
      return { artwork, image: await RawImage.fromBlob(blob) };
    } catch (error) {
      failures.push({
        id: artwork.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  });

  // Inference runs sequentially: the ONNX session is single threaded and shared.
  const records = [];
  for (const entry of images) {
    if (!entry) continue;
    const { artwork, image } = entry;

    try {
      const pixels = (await image.resize(HASH_IMAGE_SIZE, HASH_IMAGE_SIZE)).rgba();
      const hash = bmvbhash(
        { width: pixels.width, height: pixels.height, data: pixels.data },
        HASH_BITS
      );

      const { image_embeds: embeds } = await model(await processor(image));
      const vector = Array.from(embeds.data);
      let norm = 0;
      for (const value of vector) norm += value * value;
      norm = Math.sqrt(norm) || 1;

      // Fields are listed explicitly so the committed JSON keeps a stable key order.
      records.push({
        id: artwork.id,
        artist: artwork.artist,
        title: artwork.title,
        ...(artwork.year ? { year: artwork.year } : {}),
        collection: artwork.collection,
        imageUrl: artwork.imageUrl,
        sourceUrl: artwork.sourceUrl,
        hash,
        ...quantize(vector.map((value) => value / norm)),
      });
    } catch (error) {
      failures.push({
        id: artwork.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    if (records.length % 50 === 0 && records.length > 0) {
      console.log(`  ${records.length}/${unique.length}`);
    }
  }

  const artworks = records.sort(
    (a, b) => a.collection.localeCompare(b.collection) || a.id.localeCompare(b.id)
  );

  for (const failure of failures) {
    console.warn(`Skipped ${failure.id}: ${failure.reason}`);
  }

  if (artworks.length === 0) {
    throw new Error("No artwork could be fingerprinted, refusing to write an empty catalogue.");
  }

  let previousCount = 0;
  try {
    const previous = JSON.parse(await readFile(OUTPUT_PATH, "utf8"));
    previousCount = Array.isArray(previous.artworks) ? previous.artworks.length : 0;
  } catch {
    previousCount = 0;
  }

  if (previousCount > 0 && artworks.length < previousCount * MIN_CATALOG_RATIO) {
    throw new Error(
      `Catalogue shrank from ${previousCount} to ${artworks.length} artworks, refusing to overwrite. ` +
        "Re-run once the source site is healthy."
    );
  }

  const catalog = {
    embeddingModel: EMBEDDING_MODEL,
    embeddingDims: 512,
    hashAlgorithm: "blockhash",
    hashBits: HASH_BITS,
    hashImageSize: HASH_IMAGE_SIZE,
    count: artworks.length,
    artworks,
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

  console.log(
    `Wrote ${artworks.length} artworks to ${path.relative(ROOT, OUTPUT_PATH)}` +
      (failures.length ? ` (${failures.length} skipped)` : "")
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
