"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type CameraStatus = "idle" | "starting" | "ready" | "error";

export type CapturedFrame = {
  photo: string;
  canvas: HTMLCanvasElement;
};

/** Longest edge of the JPEG kept for the result screen. CLIP resizes the canvas itself. */
const MAX_CAPTURE_EDGE = 1280;
const CAPTURE_QUALITY = 0.85;

function messageForError(cause: unknown): string {
  const name = cause instanceof DOMException || cause instanceof Error ? cause.name : "";

  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "Camera access denied. Please enable permissions in your browser settings.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No camera was found on this device.";
    case "NotReadableError":
    case "TrackStartError":
      return "The camera is already in use by another application.";
    case "OverconstrainedError":
      return "No camera matches the required settings.";
    case "SecurityError":
      return "Camera access requires a secure (HTTPS) connection.";
    default:
      return "The camera could not be started. Please try again.";
  }
}

export function useCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [isActive, setIsActive] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<CameraStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  useEffect(() => {
    if (!isActive) return;

    let cancelled = false;

    async function openStream() {
      try {
        // `ideal` keeps desktop webcams working while preferring the rear camera on phones.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;

        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
        }

        setStatus("ready");
      } catch (cause) {
        if (cancelled) return;
        setStatus("error");
        setError(messageForError(cause));
      }
    }

    openStream();

    return () => {
      cancelled = true;
      releaseStream();
    };
  }, [isActive, attempt, releaseStream]);

  const start = useCallback(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("error");
      setError(
        window.isSecureContext
          ? "This browser does not support camera access."
          : "Camera access requires a secure (HTTPS) connection."
      );
      return;
    }

    setStatus("starting");
    setError(null);
    setIsActive(true);
    setAttempt((value) => value + 1);
  }, []);

  const stop = useCallback(() => {
    setIsActive(false);
    setStatus("idle");
    setError(null);
    releaseStream();
  }, [releaseStream]);

  const capture = useCallback((): CapturedFrame | null => {
    const video = videoRef.current;
    if (!video || video.readyState < video.HAVE_CURRENT_DATA) return null;

    const { videoWidth, videoHeight } = video;
    if (!videoWidth || !videoHeight) return null;

    const scale = Math.min(1, MAX_CAPTURE_EDGE / Math.max(videoWidth, videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(videoWidth * scale);
    canvas.height = Math.round(videoHeight * scale);

    const context = canvas.getContext("2d");
    if (!context) return null;

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return { photo: canvas.toDataURL("image/jpeg", CAPTURE_QUALITY), canvas };
  }, []);

  return { videoRef, status, error, isActive, start, stop, capture };
}
