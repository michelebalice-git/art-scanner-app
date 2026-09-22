/**
 * Measures how well the catalogue embeddings separate a real photo of a known artwork
 * from everything else, and reports how each acceptance threshold would behave.
 *
 * A visitor photo is approximated by degrading the catalogue image: the artwork is
 * reframed, tilted, brightened and re-encoded as a lossy JPEG.
 *
 * Run it after changing the embedding model or the acceptance rules:
 *   node scripts/evaluate-matching.mjs
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";
import {
  AutoProcessor,
  CLIPVisionModelWithProjection,
  RawImage,
  env,
} from "@huggingface/transformers";

const ROOT = path.resolve(import.meta.dirname, "..");
const SAMPLE_SIZE = 30;

env.allowLocalModels = false;
env.cacheDir = path.join(ROOT, ".cache", "transformers");

const catalog = JSON.parse(
  await readFile(path.join(ROOT, "public", "data", "art_catalog.json"), "utf8")
);

function dequantize({ embedding, embeddingScale }) {
  const raw = Buffer.from(embedding, "base64");
  const bytes = new Int8Array(raw.buffer, raw.byteOffset, raw.byteLength);

  const vector = new Float32Array(bytes.length);
  let norm = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    vector[i] = bytes[i] * embeddingScale;
    norm += vector[i] * vector[i];
  }

  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
  return vector;
}

function cosine(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

const vectors = catalog.artworks.map(dequantize);

const processor = await AutoProcessor.from_pretrained(catalog.embeddingModel);
const model = await CLIPVisionModelWithProjection.from_pretrained(catalog.embeddingModel, {
  dtype: "q8",
});

async function embed(buffer) {
  const image = await RawImage.fromBlob(new Blob([buffer]));
  const { image_embeds: embeds } = await model(await processor(image));

  const vector = Float32Array.from(embeds.data);
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
  return vector;
}

/** Reframes, tilts and re-encodes the artwork the way a hand-held phone would. */
async function simulatePhoto(buffer) {
  const { width, height } = await sharp(buffer).metadata();
  const tilted = await sharp(buffer).rotate(2, { background: "#111" }).toBuffer();
  const inset = 0.06;

  return sharp(tilted)
    .extract({
      left: Math.round(width * inset),
      top: Math.round(height * inset),
      width: Math.round(width * (1 - 2 * inset)),
      height: Math.round(height * (1 - 2 * inset)),
    })
    .modulate({ brightness: 1.12, saturation: 0.92 })
    .jpeg({ quality: 70 })
    .toBuffer();
}

const step = Math.max(1, Math.floor(catalog.artworks.length / SAMPLE_SIZE));
const samples = catalog.artworks.filter((_, index) => index % step === 0).slice(0, SAMPLE_SIZE);

console.log(`Evaluating ${samples.length} of ${catalog.artworks.length} artworks...\n`);

const results = [];
for (const artwork of samples) {
  const index = catalog.artworks.indexOf(artwork);
  const response = await fetch(artwork.imageUrl);
  const original = Buffer.from(await response.arrayBuffer());
  const vector = await embed(await simulatePhoto(original));

  const ranked = vectors
    .map((candidate, i) => ({ index: i, score: cosine(vector, candidate) }))
    .sort((a, b) => b.score - a.score);

  const own = ranked.find((entry) => entry.index === index);
  const others = ranked.filter((entry) => entry.index !== index);

  results.push({
    id: artwork.id,
    correct: ranked[0].index === index,
    score: own.score,
    runnerUp: others[0].score,
    // What the best match would look like if this artwork were not in the catalogue at all.
    unknownBest: others[0].score,
    unknownMargin: others[0].score - others[1].score,
  });
}

const ranked = results.filter((result) => result.correct).length;
console.log(`Top-1 accuracy: ${ranked}/${results.length}`);

const scores = results.map((r) => r.score).sort((a, b) => a - b);
const margins = results.map((r) => r.score - r.runnerUp).sort((a, b) => a - b);
const unknownScores = results.map((r) => r.unknownBest).sort((a, b) => b - a);

console.log(`\nKnown artwork, score of the right entry:`);
console.log(`  worst ${scores[0].toFixed(3)} | median ${scores[Math.floor(scores.length / 2)].toFixed(3)} | best ${scores.at(-1).toFixed(3)}`);
console.log(`Known artwork, lead over the runner-up:`);
console.log(`  worst ${margins[0].toFixed(3)} | median ${margins[Math.floor(margins.length / 2)].toFixed(3)}`);
console.log(`Unknown artwork, score of the best wrong entry:`);
console.log(`  worst ${unknownScores[0].toFixed(3)} | median ${unknownScores[Math.floor(unknownScores.length / 2)].toFixed(3)}`);

console.log(`\nAcceptance rules (accepted = shown to the visitor):`);
console.log(`  minScore  minMargin  known accepted  unknown wrongly accepted`);

for (const minScore of [0.75, 0.8, 0.82, 0.85, 0.88]) {
  for (const minMargin of [0, 0.02, 0.04, 0.06]) {
    const accepted = results.filter(
      (r) => r.correct && r.score >= minScore && r.score - r.runnerUp >= minMargin
    ).length;
    const falseAccepts = results.filter(
      (r) => r.unknownBest >= minScore && r.unknownMargin >= minMargin
    ).length;

    console.log(
      `  ${minScore.toFixed(2)}      ${minMargin.toFixed(2)}       ` +
        `${String(accepted).padStart(2)}/${results.length}           ${String(falseAccepts).padStart(2)}/${results.length}`
    );
  }
}

const failures = results.filter((r) => !r.correct);
if (failures.length > 0) {
  console.log(`\nMisranked:`);
  for (const failure of failures) {
    console.log(`  ${failure.id}: own ${failure.score.toFixed(3)} vs best other ${failure.runnerUp.toFixed(3)}`);
  }
}
