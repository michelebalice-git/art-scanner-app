"use client";

import {
  AutoProcessor,
  CLIPVisionModelWithProjection,
  RawImage,
  env,
  type ProgressCallback,
  type ProgressInfo,
} from "@huggingface/transformers";

import { transformersIndexedDbCache } from "@/lib/transformers-idb-cache";

/** Must stay aligned with scripts/update-catalog.js and public/data/art_catalog.json. */
export const EMBEDDING_MODEL = "Xenova/clip-vit-base-patch32";
export const EMBEDDING_DIMS = 512;

export type MatcherLoadPhase = "downloading" | "preparing";

export type MatcherLoadProgress = {
  phase: MatcherLoadPhase;
  percent: number;
};

type MatcherEngine = {
  embed(source: HTMLCanvasElement | Blob | string): Promise<number[]>;
};

let enginePromise: Promise<MatcherEngine> | null = null;

function configureBrowserCache() {
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useFS = false;
  env.useFSCache = false;
  env.useBrowserCache = false;
  env.useWasmCache = true;
  env.useCustomCache = true;
  env.customCache = transformersIndexedDbCache as typeof env.customCache;
}

function l2Normalize(values: ArrayLike<number>): number[] {
  const vector = new Array<number>(values.length);
  let norm = 0;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    vector[index] = value;
    norm += value * value;
  }

  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] /= norm;
  }

  return vector;
}

function createProgressTracker(onProgress?: (progress: MatcherLoadProgress) => void): ProgressCallback {
  let sawRemoteDownload = false;
  let percent = 0;

  return (info: ProgressInfo) => {
    if (info.status === "download" || info.status === "progress") {
      sawRemoteDownload = true;
    }

    if (info.status === "progress_total" && typeof info.progress === "number") {
      percent = Math.max(percent, Math.min(100, info.progress));
    } else if (info.status === "progress" && typeof info.progress === "number") {
      percent = Math.max(percent, Math.min(100, info.progress));
    } else if (info.status === "ready" || info.status === "done") {
      percent = Math.max(percent, 100);
    }

    onProgress?.({
      phase: sawRemoteDownload ? "downloading" : "preparing",
      percent,
    });
  };
}

async function createEngine(onProgress?: (progress: MatcherLoadProgress) => void): Promise<MatcherEngine> {
  configureBrowserCache();

  const progress_callback = createProgressTracker(onProgress);

  const [processor, model] = await Promise.all([
    AutoProcessor.from_pretrained(EMBEDDING_MODEL, { progress_callback }),
    CLIPVisionModelWithProjection.from_pretrained(EMBEDDING_MODEL, {
      dtype: "q8",
      device: "wasm",
      progress_callback,
    }),
  ]);

  onProgress?.({ phase: "preparing", percent: 100 });

  return {
    async embed(source) {
      const image =
        source instanceof HTMLCanvasElement
          ? RawImage.fromCanvas(source)
          : await RawImage.read(source);

      const { image_embeds } = await model(await processor(image));
      const values = Array.from(image_embeds.data as ArrayLike<number>);

      if (values.length !== EMBEDDING_DIMS) {
        throw new Error(`Unexpected embedding size (${values.length}).`);
      }

      return l2Normalize(values);
    },
  };
}

export function loadMatcherEngine(
  onProgress?: (progress: MatcherLoadProgress) => void
): Promise<MatcherEngine> {
  if (!enginePromise) {
    enginePromise = createEngine(onProgress).catch((error) => {
      enginePromise = null;
      throw error;
    });
  }

  return enginePromise;
}
