import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { Collection, CollectionItem } from "../shared/types";
import { isErrorResponse } from "../shared/dispatch";
import { logErr } from "../shared/logger";

const collections = signal<Collection[]>([]);
const selectedCollection = signal<Collection | null>(null);
const items = signal<CollectionItem[]>([]);
const loading = signal(false);
const loadingItems = signal(false);
const itemCounts = signal<Record<number, number>>({});
const allItemsLoaded = signal(false);
const itemPage = signal(0);
const ITEMS_PER_PAGE = 30;

export function CollectionsPanel() {
  function loadCollections() {
    loading.value = true;
    chrome.runtime.sendMessage(
      { type: "GET_COLLECTIONS" },
      (resp: { collections?: Collection[]; counts?: Record<number, number> } | null) => {
        loading.value = false;
        if (isErrorResponse(resp)) {
          logErr("Popup", `GET_COLLECTIONS fehlgeschlagen: ${resp.error}`);
          return;
        }
        if (resp?.collections) collections.value = resp.collections;
        if (resp?.counts) itemCounts.value = resp.counts;
      }
    );
  }

  function loadItems(collectionId: number, reset: boolean) {
    if (reset) {
      items.value = [];
      itemPage.value = 0;
      allItemsLoaded.value = false;
    }
    loadingItems.value = true;
    const page = reset ? 0 : itemPage.value;
    chrome.runtime.sendMessage(
      { type: "GET_COLLECTION_ITEMS", collectionId, offset: page * ITEMS_PER_PAGE, limit: ITEMS_PER_PAGE },
      (resp: { items?: CollectionItem[]; atEnd?: boolean } | null) => {
        loadingItems.value = false;
        if (isErrorResponse(resp)) {
          logErr("Popup", `GET_COLLECTION_ITEMS fehlgeschlagen: ${resp.error}`);
          return;
        }
        if (resp?.items) {
          items.value = reset ? resp.items : [...items.value, ...resp.items];
          allItemsLoaded.value = !!resp.atEnd;
          itemPage.value = reset ? 1 : page + 1;
        }
      }
    );
  }

  function selectCollection(col: Collection) {
    selectedCollection.value = col;
    loadItems(col.id, true);
  }

  function goBack() {
    selectedCollection.value = null;
    items.value = [];
  }

  function handleImageLoad(itemId: number, e: Event) {
    const img = e.target as HTMLImageElement;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64 = (reader.result as string).split(",")[1];
          chrome.runtime.sendMessage({ type: "CACHE_THUMB", itemId, blobBase64: base64 });
        };
        reader.readAsDataURL(blob);
      }, "image/jpeg", 0.7);
    } catch { /* fire and forget */ }
  }

  function openItem(itemId: number) {
    chrome.tabs.create({ url: `https://pr0gramm.com/new/${itemId}` });
  }

  function getThumbSrc(item: CollectionItem): string | null {
    if (item.thumb) return `https://thumb.pr0gramm.com/${item.thumb}`;
    return null;
  }

  function formatDate(ts: number): string {
    return new Date(ts * 1000).toLocaleDateString("de-DE");
  }

  useEffect(() => { loadCollections(); }, []);

  // View 2: Item Grid
  if (selectedCollection.value) {
    return (
      <div class="collection-detail">
        <div class="collection-detail-header">
          <button class="btn back-btn" onClick={goBack}>← Zurück</button>
          <span class="collection-detail-name">{selectedCollection.value.name}</span>
        </div>

        {loadingItems.value && items.value.length === 0 && (
          <div class="loading">Lade Items…</div>
        )}

        {!loadingItems.value && items.value.length === 0 && (
          <div class="empty-state">Keine Items in dieser Sammlung.</div>
        )}

        <div class="collection-grid">
          {items.value.map((item) => {
            const src = getThumbSrc(item);
            return (
              <div
                key={item.itemId}
                class="collection-grid-item"
                onClick={() => openItem(item.itemId)}
                title={`${item.user} — ${formatDate(item.created)}`}
              >
                {src ? (
                  <img
                    src={src}
                    alt=""
                    loading="lazy"
                    onLoad={(e) => handleImageLoad(item.itemId, e)}
                  />
                ) : (
                  <div class="thumb-placeholder" />
                )}
              </div>
            );
          })}
        </div>

        {!allItemsLoaded.value && items.value.length > 0 && (
          <button
            class="btn full-width"
            onClick={() => loadItems(selectedCollection.value!.id, false)}
            disabled={loadingItems.value}
          >
            {loadingItems.value ? "Lade…" : "Mehr laden"}
          </button>
        )}
      </div>
    );
  }

  // View 1: Collection List
  return (
    <div class="collections-panel">
      <button class="btn full-width" onClick={loadCollections} disabled={loading.value}>
        {loading.value ? "Lade…" : "Aktualisieren"}
      </button>

      {collections.value.length === 0 && !loading.value && (
        <div class="empty-state">
          <p>Keine Sammlungen gefunden.</p>
          <p class="hint">Erstelle Sammlungen auf pr0gramm.com und synce dann.</p>
        </div>
      )}

      <div class="collection-list">
        {collections.value.map((col) => (
          <div
            key={col.id}
            class="collection-card"
            onClick={() => selectCollection(col)}
          >
            <div class="collection-card-header">
              <span class="collection-card-name">{col.name}</span>
              <div class="collection-card-badges">
                {col.isCurated && <span class="badge curated">Kuratiert</span>}
                {col.isPublic && <span class="badge public">Öffentlich</span>}
                {!col.isPublic && <span class="badge private">Privat</span>}
              </div>
            </div>
            <div class="collection-card-count">
              {(itemCounts.value[col.id] ?? 0).toLocaleString()} Items
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
