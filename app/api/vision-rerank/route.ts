import OpenAI from "openai";
import sharp from "sharp";

import { artCatalog } from "@/lib/art-catalog";
import { withWikipedia } from "@/lib/artwork-info";

type ContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;

const MODEL = "gpt-4o-mini";
const NOT_RECOGNIZED = "Artwork not recognized";
const MAX_CANDIDATES = 5;
const MAX_IMAGE_CHARS = 2 * 1024 * 1024;
const IMAGE_DATA_URL = /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const ALLOWED_IMAGE_HOST = "www.pkb.ch";

const SYSTEM_PROMPT = [
  "You compare a visitor's photograph of an artwork against a short list of catalogue photos.",
  "The visitor photo may include glass reflections, a picture frame, glare or uneven lighting.",
  "Ignore those artefacts. Rank every candidate from most to least likely to be the same artwork.",
  "Only ever refer to candidates by the id you are given. Answer with JSON only.",
].join(" ");

const USER_PROMPT = [
  "The first image is the visitor photo.",
  "Each following image is a catalogue candidate, preceded by its id.",
  "Return ONLY JSON: { ranked_ids: string[] }.",
  "ranked_ids lists every candidate id you were given, ordered from most probable to least probable.",
  "Do not invent ids. Include each provided id exactly once.",
  "Different artists often painted the same subject: rank by composition, colours and details, not just the theme.",
].join(" ");

function parseJsonContent(content: string | null | undefined): Record<string, unknown> | null {
  if (!content) return null;

  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseCandidateIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CANDIDATES) return null;

  const ids: string[] = [];
  for (const entry of value) {
    const id =
      typeof entry === "string"
        ? entry.trim()
        : typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string"
          ? (entry as { id: string }).id.trim()
          : "";
    if (!id || ids.includes(id)) continue;
    ids.push(id);
  }

  return ids.length > 0 ? ids : null;
}

function parseRankedIds(value: unknown, allowed: string[]): string[] {
  const raw = Array.isArray(value) ? value : [];
  const allowedSet = new Set(allowed);
  const ranked: string[] = [];

  for (const entry of raw) {
    const id = typeof entry === "string" ? entry.trim() : "";
    if (!id || !allowedSet.has(id) || ranked.includes(id)) continue;
    ranked.push(id);
  }

  for (const id of allowed) {
    if (!ranked.includes(id)) ranked.push(id);
  }

  return ranked;
}

function isAllowedImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === ALLOWED_IMAGE_HOST;
  } catch {
    return false;
  }
}

async function catalogueImageAsDataUrl(imageUrl: string): Promise<string> {
  const response = await fetch(imageUrl, {
    headers: { Accept: "image/*", "User-Agent": "ArtScanner/1.0" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Could not load catalogue image (${response.status}).`);

  const jpeg = await sharp(Buffer.from(await response.arrayBuffer()))
    .resize({ width: 768, withoutEnlargement: true })
    .jpeg({ quality: 70 })
    .toBuffer();

  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Image recognition is not configured on the server." },
      { status: 500 }
    );
  }

  let body: { image?: unknown; candidates?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const photo = typeof body.image === "string" ? body.image : "";
  if (!IMAGE_DATA_URL.test(photo)) {
    return Response.json(
      { error: "A compressed base64 JPEG, PNG or WebP photo is required." },
      { status: 400 }
    );
  }
  if (photo.length > MAX_IMAGE_CHARS) {
    return Response.json({ error: "The photo is too large." }, { status: 413 });
  }

  const candidateIds = parseCandidateIds(body.candidates);
  if (!candidateIds) {
    return Response.json({ error: "Between 1 and 5 catalogue candidates are required." }, { status: 400 });
  }

  const candidates = candidateIds
    .map((id) => artCatalog.artworks.find((artwork) => artwork.id === id))
    .filter((artwork): artwork is NonNullable<typeof artwork> => Boolean(artwork));

  if (candidates.length === 0) {
    return Response.json({ error: "None of the candidates are in the catalogue." }, { status: 400 });
  }

  for (const artwork of candidates) {
    if (!isAllowedImageUrl(artwork.imageUrl)) {
      return Response.json({ error: "A candidate image URL is not allowed." }, { status: 400 });
    }
  }

  let images: string[];
  try {
    images = await Promise.all(candidates.map((artwork) => catalogueImageAsDataUrl(artwork.imageUrl)));
  } catch (cause) {
    console.error("Catalogue image download failed", cause);
    return Response.json(
      { error: "The recognition service is unavailable. Please try again." },
      { status: 502 }
    );
  }

  const content: ContentPart[] = [
    { type: "text", text: USER_PROMPT },
    { type: "text", text: "Visitor photo:" },
    { type: "image_url", image_url: { url: photo, detail: "high" } },
  ];

  for (const [index, artwork] of candidates.entries()) {
    content.push({
      type: "text",
      text: `Candidate ${artwork.id}: ${artwork.artist} | ${artwork.title}`,
    });
    content.push({ type: "image_url", image_url: { url: images[index], detail: "low" } });
  }

  const client = new OpenAI({ apiKey, timeout: 25_000, maxRetries: 1 });

  let parsed: Record<string, unknown> | null = null;
  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ],
    });
    parsed = parseJsonContent(completion.choices[0]?.message?.content);
  } catch (cause) {
    console.error("Vision rerank failed", cause);
    return Response.json(
      { error: "The recognition service is unavailable. Please try again." },
      { status: 502 }
    );
  }

  const ranked_ids = parseRankedIds(
    parsed?.ranked_ids ?? parsed?.rankedIds,
    candidates.map((candidate) => candidate.id)
  );
  const artwork = candidates.find((candidate) => candidate.id === ranked_ids[0]);

  if (!artwork || ranked_ids.length === 0) {
    return Response.json({ error: NOT_RECOGNIZED }, { status: 404 });
  }

  return Response.json({
    ranked_ids,
    ...(await withWikipedia(artwork, 1)),
  });
}
