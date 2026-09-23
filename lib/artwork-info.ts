import { findWikipediaUrl } from "@/app/api/identify/wikipedia";

export type ArtworkInfo = {
  artist: string;
  title: string;
  imageUrl: string;
  year?: string;
  collection?: string;
};

export async function withWikipedia(artwork: ArtworkInfo, matchScore: number) {
  const [artistWikipediaUrl, titleWikipediaUrl] = await Promise.all([
    findWikipediaUrl(artwork.artist),
    findWikipediaUrl(artwork.title, { minTokens: 2 }),
  ]);

  return {
    artist: artwork.artist,
    title: artwork.title,
    imageUrl: artwork.imageUrl,
    year: artwork.year,
    collection: artwork.collection,
    matchScore,
    artistWikipediaUrl,
    titleWikipediaUrl,
  };
}
