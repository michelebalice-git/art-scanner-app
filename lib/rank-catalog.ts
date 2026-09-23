import type { CatalogArtwork } from "./art-catalog";

export const INSTANT_MATCH_SCORE = 0.85;
export const RERANK_MIN_SCORE = 0.4;
export const RERANK_CANDIDATE_COUNT = 5;

export type RankedArtwork = {
  artwork: CatalogArtwork;
  score: number;
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

export function dequantizeEmbedding(embedding: string, scale: number): Float32Array {
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

export function normalizeEmbedding(values: number[]): Float32Array {
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

function cosine(left: ArrayLike<number>, right: ArrayLike<number>): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    sum += left[index] * right[index];
  }
  return sum;
}

export function rankCatalog(
  embedding: number[],
  artworks: CatalogArtwork[],
  vectors: Float32Array[],
  topK: number
): RankedArtwork[] {
  if (artworks.length === 0 || embedding.length !== vectors[0]?.length) return [];

  const query = normalizeEmbedding(embedding);
  const ranked: RankedArtwork[] = [];

  for (let index = 0; index < artworks.length; index += 1) {
    ranked.push({ artwork: artworks[index], score: cosine(query, vectors[index]) });
  }

  ranked.sort((left, right) => right.score - left.score);
  return ranked.slice(0, topK);
}
