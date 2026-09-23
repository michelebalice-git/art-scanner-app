"use strict";

/**
 * Prints a high-resolution QR code that opens the live Art Scanner.
 *
 * The production URL is fixed. An optional CLI argument overrides it for a
 * one-off print (local preview, staging) without editing the file:
 *
 *   npm run generate-qr
 *   npm run generate-qr -- https://example.com/
 */

const path = require("node:path");
const QRCode = require("qrcode");

const APP_URL = "https://art-scanner-app.vercel.app/";
const OUTPUT_PATH = path.resolve(__dirname, "..", "app-qrcode.png");
const PIXEL_SIZE = 2048;

function resolveUrl(value) {
  const candidate = (value ?? APP_URL).trim();
  let parsed;

  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Not a valid URL: ${candidate}`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`QR codes must point at an http(s) address: ${candidate}`);
  }

  return parsed.href;
}

async function main() {
  const url = resolveUrl(process.argv[2]);

  await QRCode.toFile(OUTPUT_PATH, url, {
    type: "png",
    width: PIXEL_SIZE,
    margin: 4,
    errorCorrectionLevel: "H",
    color: {
      dark: "#111111",
      light: "#ffffff",
    },
  });

  console.log(`Wrote ${path.relative(process.cwd(), OUTPUT_PATH)} → ${url}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
