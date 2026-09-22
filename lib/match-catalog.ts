import { artCatalog, type CatalogArtwork } from "./art-catalog";

/**
 * Calibrated against scripts/evaluate-matching.mjs (30 catalogue photos, simulated
 * phone capture). Score 0.82 covers the weakest correct match (0.824). A 0.04 lead
 * over the runner-up refuses the two series siblings the model swapped, at the cost
 * of also refusing a few other near-duplicate series works.
 */
export const MIN_MATCH_SCORE = 0.82;
export const MIN_MARGIN = 0.04;

export type CatalogMatch = {
  artwork: CatalogArtwork;
  matchScore: number;
  margin: number;
};

function decodeBase64(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(value, "base64");
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function dequantize(embedding: string, scale: number): Float32Array {
  const raw = decodeBase64(embedding);
  const bytes = new Int8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  const vector = new Float32Array(bytes.length);
  let norm = 0;

  for (let index = 0; index < bytes.length; index += 1) {
    vector[index] = bytes[index] * scale;
    norm += vector[index] * vector[index];
  }

  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] /= norm;
  }

  return vector;
}

function cosine(left: ArrayLike<number>, right: ArrayLike<number>): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    sum += left[index] * right[index];
  }
  return sum;
}

function normalize(values: number[]): Float32Array {
  const vector = new Float32Array(values.length);
  let norm = 0;

  for (let index = 0; index < values.length; index += 1) {
    vector[index] = values[index];
    norm += values[index] * values[index];
  }

  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] /= norm;
  }

  return vector;
}

const catalogVectors = artCatalog.artworks.map((artwork) =>
  dequantize(artwork.embedding, artwork.embeddingScale)
);

export function findCatalogMatch(embedding: number[]): CatalogMatch | null {
  if (embedding.length !== artCatalog.embeddingDims) return null;

  const query = normalize(embedding);
  let best = { index: -1, score: -Infinity };
  let second = { index: -1, score: -Infinity };

  for (let index = 0; index < catalogVectors.length; index += 1) {
    const score = cosine(query, catalogVectors[index]);
    if (score > best.score) {
      second = best;
      best = { index, score };
    } else if (score > second.score) {
      second = { index, score };
    }
  }

  if (best.index < 0) return null;

  const margin = Number.isFinite(second.score) ? best.score - second.score : best.score;
  if (best.score < MIN_MATCH_SCORE || margin < MIN_MARGIN) return null;

  return {
    artwork: artCatalog.artworks[best.index],
    matchScore: best.score,
    margin,
  };
}
