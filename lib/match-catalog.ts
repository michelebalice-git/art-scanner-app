import { artCatalog } from "./art-catalog";
import { dequantizeEmbedding, rankCatalog, type RankedArtwork } from "./rank-catalog";

/**
 * Server-side fallback used by /api/identify. The browser now ranks locally and only
 * asks the server to confirm noisy photos; these gates keep the embedding-only path
 * from returning a weak guess.
 */
export const MIN_MATCH_SCORE = 0.82;
export const MIN_MARGIN = 0.04;

export type CatalogMatch = {
  artwork: RankedArtwork["artwork"];
  matchScore: number;
  margin: number;
};

const catalogVectors = artCatalog.artworks.map((artwork) =>
  dequantizeEmbedding(artwork.embedding, artwork.embeddingScale)
);

export function findCatalogMatch(embedding: number[]): CatalogMatch | null {
  const ranked = rankCatalog(embedding, artCatalog.artworks, catalogVectors, 2);
  const best = ranked[0];
  if (!best) return null;

  const margin = ranked[1] ? best.score - ranked[1].score : best.score;
  if (best.score < MIN_MATCH_SCORE || margin < MIN_MARGIN) return null;

  return { artwork: best.artwork, matchScore: best.score, margin };
}
