import { artCatalog } from "@/lib/art-catalog";
import { findCatalogMatch } from "@/lib/match-catalog";

import { findWikipediaUrl } from "./wikipedia";

const NOT_RECOGNIZED = "Artwork not recognized";

function parseEmbedding(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== artCatalog.embeddingDims) return null;

  const embedding = new Array<number>(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "number" || !Number.isFinite(item)) return null;
    embedding[index] = item;
  }

  return embedding;
}

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: { embedding?: unknown; image?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (body.image !== undefined && body.embedding === undefined) {
    return Response.json(
      { error: "Send the image embedding, not the photo." },
      { status: 400 }
    );
  }

  const embedding = parseEmbedding(body.embedding);
  if (!embedding) {
    return Response.json(
      { error: `A numeric embedding of length ${artCatalog.embeddingDims} is required.` },
      { status: 400 }
    );
  }

  const match = findCatalogMatch(embedding);
  if (!match) {
    return Response.json({ error: NOT_RECOGNIZED }, { status: 404 });
  }

  const { artwork, matchScore } = match;
  const [artistWikipediaUrl, titleWikipediaUrl] = await Promise.all([
    findWikipediaUrl(artwork.artist),
    findWikipediaUrl(artwork.title, { minTokens: 2 }),
  ]);

  return Response.json({
    artist: artwork.artist,
    title: artwork.title,
    imageUrl: artwork.imageUrl,
    year: artwork.year,
    collection: artwork.collection,
    matchScore,
    artistWikipediaUrl,
    titleWikipediaUrl,
  });
}
