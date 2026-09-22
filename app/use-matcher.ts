"use client";

import { useCallback, useEffect, useState } from "react";

import type { MatcherLoadPhase } from "./matcher-engine";

export type MatcherStatus = "loading" | "ready" | "error";

type EmbedFn = (source: HTMLCanvasElement | Blob | string) => Promise<number[]>;

export function useMatcher() {
  const [status, setStatus] = useState<MatcherStatus>("loading");
  const [phase, setPhase] = useState<MatcherLoadPhase>("preparing");
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [embedFn, setEmbedFn] = useState<EmbedFn | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const { loadMatcherEngine } = await import("./matcher-engine");
        const engine = await loadMatcherEngine((progress) => {
          if (cancelled) return;
          setPhase(progress.phase);
          setPercent(progress.percent);
        });

        if (cancelled) return;
        setEmbedFn(() => engine.embed);
        setPercent(100);
        setStatus("ready");
      } catch (cause) {
        if (cancelled) return;
        setStatus("error");
        setError(
          cause instanceof Error
            ? cause.message
            : "The matching engine could not be loaded."
        );
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const embed = useCallback(
    async (source: HTMLCanvasElement | Blob | string) => {
      if (!embedFn) {
        throw new Error("The matching engine is still loading.");
      }
      return embedFn(source);
    },
    [embedFn]
  );

  const retry = useCallback(() => {
    setStatus("loading");
    setError(null);
    setPercent(0);
    setPhase("preparing");
    setEmbedFn(null);
    setAttempt((value) => value + 1);
  }, []);

  return { status, phase, percent, error, embed, retry };
}
