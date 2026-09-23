"use client";

import { useCallback, useEffect, useState } from "react";

import type { ArtCatalog, CatalogArtwork } from "@/lib/art-catalog";
import { dequantizeEmbedding, rankCatalog, type RankedArtwork } from "@/lib/rank-catalog";

export type CatalogStatus = "loading" | "ready" | "error";

export function useCatalog() {
  const [status, setStatus] = useState<CatalogStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [artworks, setArtworks] = useState<CatalogArtwork[]>([]);
  const [vectors, setVectors] = useState<Float32Array[]>([]);
  const [dims, setDims] = useState(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch("/data/art_catalog.json");
        if (!response.ok) throw new Error("The artwork catalogue could not be loaded.");

        const catalog = (await response.json()) as ArtCatalog;
        if (!Array.isArray(catalog.artworks) || catalog.artworks.length === 0) {
          throw new Error("The artwork catalogue is empty.");
        }

        const decoded = catalog.artworks.map((artwork) =>
          dequantizeEmbedding(artwork.embedding, artwork.embeddingScale)
        );

        if (cancelled) return;
        setArtworks(catalog.artworks);
        setVectors(decoded);
        setDims(catalog.embeddingDims);
        setStatus("ready");
      } catch (cause) {
        if (cancelled) return;
        setStatus("error");
        setError(cause instanceof Error ? cause.message : "The artwork catalogue could not be loaded.");
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const rank = useCallback(
    (embedding: number[], topK: number): RankedArtwork[] => {
      if (status !== "ready" || embedding.length !== dims) return [];
      return rankCatalog(embedding, artworks, vectors, topK);
    },
    [artworks, dims, status, vectors]
  );

  const retry = useCallback(() => {
    setError(null);
    setArtworks([]);
    setVectors([]);
    setStatus("loading");
    setAttempt((value) => value + 1);
  }, []);

  return { status, error, rank, retry };
}
