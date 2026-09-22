type CacheLike = {
  match: (request: string) => Promise<Response | undefined>;
  put: (
    request: string,
    response: Response,
    progress_callback?: (data: { progress: number; loaded: number; total: number }) => void
  ) => Promise<void>;
  delete?: (request: string) => Promise<boolean>;
};

const DB_NAME = "transformers-js";
const DB_VERSION = 1;
const STORE = "models";
const CACHE_API_NAME = "transformers-cache";

type CachedFile = {
  body: ArrayBuffer;
  contentType: string;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB failed to open."));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => Promise<T>
): Promise<T> {
  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE, mode);
    return await work(transaction.objectStore(STORE));
  } finally {
    database.close();
  }
}

async function cacheApi(): Promise<Cache | null> {
  if (typeof caches === "undefined") return null;
  try {
    return await caches.open(CACHE_API_NAME);
  } catch {
    return null;
  }
}

/**
 * Persistent model store. transformers.js v4 defaults to the Cache API; this adapter
 * writes the same files to IndexedDB so the ~25 MB CLIP weights survive reloads even
 * when the Cache API is partitioned or evicted.
 */
export const transformersIndexedDbCache: CacheLike = {
  async match(request) {
    try {
      const record = await withStore("readonly", (store) =>
        requestToPromise(store.get(request) as IDBRequest<CachedFile | undefined>)
      );

      if (record?.body) {
        return new Response(record.body, {
          status: 200,
          headers: {
            "Content-Type": record.contentType || "application/octet-stream",
            "Content-Length": String(record.body.byteLength),
          },
        });
      }
    } catch {
      // Private mode and storage-blocked browsers fall through to the Cache API.
    }

    const fallback = await cacheApi();
    return fallback ? ((await fallback.match(request)) ?? undefined) : undefined;
  },

  async put(request, response, progress_callback) {
    const body = await response.clone().arrayBuffer();
    const contentType = response.headers.get("Content-Type") || "application/octet-stream";

    try {
      await withStore("readwrite", (store) =>
        requestToPromise(store.put({ body, contentType } satisfies CachedFile, request))
      );
    } catch {
      const fallback = await cacheApi();
      if (fallback) await fallback.put(request, new Response(body, { headers: { "Content-Type": contentType } }));
    }

    progress_callback?.({ progress: 100, loaded: body.byteLength, total: body.byteLength });
  },

  async delete(request) {
    try {
      await withStore("readwrite", (store) => requestToPromise(store.delete(request)));
      return true;
    } catch {
      const fallback = await cacheApi();
      return fallback ? fallback.delete(request) : false;
    }
  },
};
