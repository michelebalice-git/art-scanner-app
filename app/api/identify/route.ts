import { artCatalog } from "@/lib/art-catalog";
import { withWikipedia } from "@/lib/artwork-info";
import { findCatalogMatch } from "@/lib/match-catalog";

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
  let body: { embedding?: unknown; image?: unknown; artist?: unknown; title?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const artist = typeof body.artist === "string" ? body.artist.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (artist && title) {
    const known = artCatalog.artworks.find(
      (artwork) => artwork.artist === artist && artwork.title === title
    );
    return Response.json(
      await withWikipedia(
        {
          artist,
          title,
          imageUrl: known?.imageUrl ?? "",
          year: known?.year,
          collection: known?.collection,
        },
        1
      )
    );
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

  return Response.json(await withWikipedia(match.artwork, match.matchScore));
}
