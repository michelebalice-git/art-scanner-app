import rawCatalog from "@/public/data/art_catalog.json";

export type CatalogArtwork = {
  id: string;
  artist: string;
  title: string;
  year?: string;
  collection: string;
  imageUrl: string;
  sourceUrl: string;
  hash: string;
  embedding: string;
  embeddingScale: number;
};

export type ArtCatalog = {
  embeddingModel: string;
  embeddingDims: number;
  hashAlgorithm: string;
  hashBits: number;
  hashImageSize: number;
  count: number;
  artworks: CatalogArtwork[];
};

export const artCatalog = rawCatalog as ArtCatalog;
