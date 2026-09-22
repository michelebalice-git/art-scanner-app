"use client";

import Image from "next/image";
import { useCallback, useState } from "react";

import { useCamera } from "./use-camera";
import { useMatcher } from "./use-matcher";

type View = "home" | "camera" | "analyzing" | "result";

type ArtworkMatch = {
  artist: string;
  title: string;
  imageUrl?: string;
  year?: string;
  artistWikipediaUrl?: string | null;
  titleWikipediaUrl?: string | null;
};

const NOT_RECOGNIZED = "Artwork not recognized";

const primaryButton =
  "inline-flex h-14 items-center justify-center rounded-full bg-zinc-900 px-8 text-base font-medium text-white transition-colors hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200 dark:focus-visible:outline-zinc-50";

const secondaryButton =
  "inline-flex h-12 items-center justify-center rounded-full border border-zinc-300 px-6 text-base font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900";

function WikipediaText({ value, href }: { value: string; href?: string | null }) {
  if (!href) return <>{value}</>;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline decoration-zinc-400 decoration-2 underline-offset-4 transition-colors hover:decoration-zinc-900 dark:decoration-zinc-600 dark:hover:decoration-zinc-50"
    >
      {value}
    </a>
  );
}

export default function Home() {
  const {
    videoRef,
    status: cameraStatus,
    error: cameraError,
    start: startCamera,
    stop: stopCamera,
    capture,
  } = useCamera();

  const {
    status: matcherStatus,
    phase: matcherPhase,
    percent: matcherPercent,
    error: matcherError,
    embed,
    retry: retryMatcher,
  } = useMatcher();

  const matcherReady = matcherStatus === "ready";

  const [view, setView] = useState<View>("home");
  const [capturedPhoto, setCapturedPhoto] = useState<string | null>(null);
  const [match, setMatch] = useState<ArtworkMatch | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const openCamera = useCallback(() => {
    if (!matcherReady) return;
    setMatch(null);
    setAnalysisError(null);
    setCapturedPhoto(null);
    setView("camera");
    startCamera();
  }, [matcherReady, startCamera]);

  const closeCamera = useCallback(() => {
    stopCamera();
    setView("home");
  }, [stopCamera]);

  const getInfo = useCallback(async () => {
    const frame = capture();
    if (!frame || !matcherReady) return;

    stopCamera();
    setCapturedPhoto(frame.photo);
    setView("analyzing");

    try {
      const embedding = await embed(frame.canvas);
      const response = await fetch("/api/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embedding }),
      });

      const data: (ArtworkMatch & { error?: string }) | null = await response
        .json()
        .catch(() => null);

      if (!response.ok || !data?.artist || !data?.title) {
        throw new Error(data?.error ?? NOT_RECOGNIZED);
      }

      setMatch(data);
    } catch (cause) {
      setAnalysisError(cause instanceof Error ? cause.message : NOT_RECOGNIZED);
    } finally {
      setView("result");
    }
  }, [capture, embed, matcherReady, stopCamera]);

  if (view === "camera") {
    return (
      <div className="fixed inset-0 z-50 bg-black">
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="h-full w-full object-cover"
        />

        <div className="absolute inset-x-0 top-0 flex justify-end px-4 pt-[calc(env(safe-area-inset-top)+1rem)]">
          <button
            type="button"
            onClick={closeCamera}
            className="rounded-full bg-black/50 px-5 py-2 text-sm font-medium text-white backdrop-blur transition-colors hover:bg-black/70"
          >
            Close
          </button>
        </div>

        {cameraStatus === "error" ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 px-6">
            <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center dark:bg-zinc-900">
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                Camera unavailable
              </h2>
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{cameraError}</p>
              <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
                <button type="button" onClick={startCamera} className={primaryButton}>
                  Try Again
                </button>
                <button type="button" onClick={closeCamera} className={secondaryButton}>
                  Back
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 bg-gradient-to-t from-black/80 to-transparent px-6 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-20">
            <p className="text-sm text-white/80">
              {cameraStatus === "ready"
                ? "Frame the artwork, then tap Get Info."
                : "Starting camera…"}
            </p>
            <button
              type="button"
              onClick={getInfo}
              disabled={cameraStatus !== "ready"}
              className="inline-flex h-14 items-center justify-center rounded-full bg-white px-10 text-base font-semibold text-zinc-900 transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Get Info
            </button>
          </div>
        )}
      </div>
    );
  }

  if (view === "analyzing") {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-black">
        {capturedPhoto ? (
          <Image
            src={capturedPhoto}
            alt=""
            fill
            unoptimized
            className="object-cover opacity-30 blur-sm"
          />
        ) : null}
        <div
          className="relative h-12 w-12 animate-spin rounded-full border-4 border-white/30 border-t-white"
          role="status"
          aria-label="Analyzing artwork"
        />
        <p className="relative text-base font-medium text-white">Identifying artwork...</p>
      </div>
    );
  }

  if (view === "result") {
    if (analysisError || !match) {
      return (
        <main className="flex flex-1 flex-col items-center justify-center gap-8 px-6 py-16 text-center">
          <div className="max-w-md space-y-3">
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50 md:text-3xl">
              {analysisError ?? NOT_RECOGNIZED}
            </h1>
            <p className="text-base text-zinc-600 dark:text-zinc-400">
              Try again with the full artwork in frame and good lighting.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <button type="button" onClick={openCamera} className={primaryButton}>
              Open Camera
            </button>
            <button type="button" onClick={() => setView("home")} className={secondaryButton}>
              Back to Home
            </button>
          </div>
        </main>
      );
    }

    const artworkImage = match.imageUrl ?? capturedPhoto;

    return (
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-10 lg:grid lg:grid-cols-2 lg:items-center lg:gap-12 lg:py-16">
        <div className="relative aspect-4/5 w-full overflow-hidden rounded-2xl bg-zinc-100 dark:bg-zinc-900">
          {artworkImage ? (
            <Image
              src={artworkImage}
              alt={`${match.title} by ${match.artist}`}
              fill
              unoptimized={artworkImage.startsWith("data:")}
              sizes="(min-width: 1024px) 45vw, 100vw"
              className="object-contain"
            />
          ) : null}
        </div>

        <div className="flex flex-col gap-6">
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-zinc-500">Title</p>
            <h1 className="text-3xl font-semibold text-zinc-900 dark:text-zinc-50 md:text-4xl">
              <WikipediaText value={match.title} href={match.titleWikipediaUrl} />
            </h1>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-zinc-500">Artist</p>
            <p className="text-xl text-zinc-700 dark:text-zinc-300 md:text-2xl">
              <WikipediaText value={match.artist} href={match.artistWikipediaUrl} />
            </p>
          </div>

          {match.year ? (
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-zinc-500">Year</p>
              <p className="text-lg text-zinc-700 dark:text-zinc-300">{match.year}</p>
            </div>
          ) : null}

          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <button type="button" onClick={openCamera} className={primaryButton}>
              Scan Another
            </button>
            <button type="button" onClick={() => setView("home")} className={secondaryButton}>
              Back to Home
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-10 px-6 py-16 text-center">
      <div className="max-w-xl space-y-4">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-zinc-500">
          PKB Art Collection
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50 md:text-5xl lg:text-6xl">
          Art Scanner
        </h1>
        <p className="text-base text-zinc-600 dark:text-zinc-400 md:text-lg">
          Take a photo of an artwork to discover its title and artist.
        </p>
      </div>

      {matcherStatus === "loading" ? (
        <div className="flex w-full max-w-sm flex-col items-center gap-3" role="status" aria-live="polite">
          <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
            <div
              className="h-full rounded-full bg-zinc-900 transition-[width] duration-300 dark:bg-zinc-50"
              style={{ width: `${Math.max(matcherPercent, 4)}%` }}
            />
          </div>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {matcherPhase === "downloading"
              ? "Downloading matching engine (only at first usage)..."
              : "Loading matching engine..."}
          </p>
        </div>
      ) : null}

      {matcherStatus === "error" ? (
        <div className="flex max-w-sm flex-col items-center gap-4">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {matcherError ?? "The matching engine could not be loaded."}
          </p>
          <button type="button" onClick={retryMatcher} className={secondaryButton}>
            Try Again
          </button>
        </div>
      ) : null}

      <button
        type="button"
        onClick={openCamera}
        disabled={!matcherReady}
        className={primaryButton}
      >
        Open Camera
      </button>

      <p className="max-w-sm text-sm text-zinc-500">
        {matcherReady
          ? "Your browser will ask for camera permission the first time you open the viewfinder."
          : "The camera unlocks after the matching engine is ready."}
      </p>
    </main>
  );
}
