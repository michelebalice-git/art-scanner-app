import OpenAI from "openai";
import sharp from "sharp";

import { artCatalog } from "@/lib/art-catalog";
import { withWikipedia } from "@/lib/artwork-info";

type ContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;

const MODEL = "gpt-4o-mini";
const NOT_RECOGNIZED = "Artwork not recognized";
const MIN_MATCH_SCORE = 0.6;
const MAX_CANDIDATES = 5;
const MAX_IMAGE_CHARS = 2 * 1024 * 1024;
const IMAGE_DATA_URL = /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const ALLOWED_IMAGE_HOST = "www.pkb.ch";

const SYSTEM_PROMPT = [
  "You compare a visitor's photograph of an artwork against a short list of catalogue photos.",
  "The visitor photo may include glass reflections, a picture frame, glare or uneven lighting.",
  "Ignore those artefacts. Decide whether one catalogue photo is the same physical artwork.",
  "Only ever refer to candidates by the id you are given. Answer with JSON only.",
].join(" ");

const USER_PROMPT = [
  "The first image is the visitor photo.",
  "Each following image is a catalogue candidate, preceded by its id.",
  "Return ONLY JSON: { id, matchScore }.",
  "id is the candidate id of the very same artwork, or an empty string when none of them is that artwork.",
  "matchScore is your confidence between 0 and 1.",
  "Different artists often painted the same subject: match composition, colours and details, not just the theme.",
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

function toMatchScore(value: unknown): number {
  const score = typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(score)) return 0;
  const normalized = score > 1 ? score / 100 : score;
  return Math.min(Math.max(normalized, 0), 1);
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

  const chosenId = typeof parsed?.id === "string" ? parsed.id.trim() : "";
  const artwork = candidates.find((candidate) => candidate.id === chosenId);
  const matchScore = toMatchScore(parsed?.matchScore);

  if (!artwork || matchScore < MIN_MATCH_SCORE) {
    return Response.json({ error: NOT_RECOGNIZED }, { status: 404 });
  }

  return Response.json(await withWikipedia(artwork, matchScore));
}
