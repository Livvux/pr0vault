// pr0Vault — Content Script (Isolated World on pr0gramm.com)
// Two responsibilities:
//   1. Inject page-hook.js into the page's MAIN world so we can actually
//      intercept pr0gramm's own fetch/XHR calls (an isolated-world override
//      is invisible to page-context code).
//   2. Receive page-hook postMessages, batch them, and forward to the
//      service worker via chrome.runtime.

import type { Upload, Comment, Message, FilterBookmark, Collection, CollectionItem } from "./shared/types";
import type { StoreBatchMessage } from "./shared/messages";
import { logSync, logErr } from "./shared/logger";
import {browser} from "./shared/browser";


const HOOK_TAG = "PR0VAULT_API";

// ---- Inject page hook ASAP ----

(function injectPageHook() {
  try {
    const url = chrome.runtime.getURL("src/page-hook.js");
    const s = document.createElement("script");
    s.src = url;
    s.async = false; // load synchronously so it runs before pr0gramm's bundle
    (document.head || document.documentElement).prepend(s);
    s.onload = () => s.remove();
  } catch (e) {
    logErr("CS", `inject page-hook failed: ${String(e)}`);
  }
})();

interface PendingBatch {
  uploads?: Upload[];
  comments?: Comment[];
  messages?: Message[];
  filters?: FilterBookmark[];
  collections?: Collection[];
  collectionItems?: CollectionItem[];
}

let pendingBatch: PendingBatch = {};
let batchTimer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  if (Object.keys(pendingBatch).length > 0) {
    const msg: StoreBatchMessage = {
      type: "STORE_BATCH",
      payload: pendingBatch,
    };
    try {

      browser.runtime.sendMessage(msg, () => {
        if (browser.runtime.lastError) {
          // SW might be inactive — silent.
        }
      });
    } catch {
      /* SW gone, ignore */
    }
    pendingBatch = {};
  }
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
}

function enqueue(table: keyof PendingBatch, items: unknown[]) {
  if (!items || items.length === 0) return;
  const existing = pendingBatch[table] || [];
  (pendingBatch[table] as unknown[]) = [...existing, ...items];
  // Debounce 500ms so bursts (page load) coalesce.
  if (batchTimer) clearTimeout(batchTimer);
  batchTimer = setTimeout(flush, 500);
}

// ---- API Response Handlers ----

function handleItemsGet(data: Record<string, unknown>) {
  const items = data.items as Upload[] | undefined;
  if (items && Array.isArray(items)) {
    enqueue("uploads", items);
  }
}

function handleProfileInfo(data: Record<string, unknown>) {
  const comments = data.comments as Comment[] | undefined;
  if (comments && Array.isArray(comments)) {
    enqueue("comments", comments);
  }
      // Store collections from profile info (includes preview items)
      const profileCollections = data.collections as any[] | undefined;
      if (profileCollections?.length) {
        console.log(`[pr0Vault CS] Found ${profileCollections.length} collections in profile/info`);
        const now = Date.now();
    const cols: Collection[] = [];
    const citems: CollectionItem[] = [];
    for (const pc of profileCollections) {
      cols.push({
        id: pc.id,
        name: pc.name ?? "",
        keyword: pc.keyword ?? "",
        isPublic: !!pc.isPublic,
        isDefault: !!pc.isDefault,
        isCurated: false,
        syncedAt: now,
      });
      if (pc.items?.length) {
        for (const it of pc.items) {
          citems.push({
            collectionId: pc.id,
            itemId: it.id,
            userId: 0,
            user: "",
            created: 0,
            image: "",
            thumb: it.thumb ?? "",
            flags: it.flags ?? 0,
            mark: 0,
            up: 0,
            down: 0,
            tags: [],
            syncedAt: now,
          });
        }
      }
    }
    if (cols.length) enqueue("collections", cols);
    if (citems.length) enqueue("collectionItems", citems);
  }
}

function handleInbox(data: Record<string, unknown>, url: string) {
  let messages: Message[] | undefined;
  if (data.messages && Array.isArray(data.messages)) {
    messages = data.messages as Message[];
  }

  if (messages) {
    const now = Date.now();
    const typed: Message[] = messages.map((m) => ({
      ...m,
      syncedAt: now,
    }));
    enqueue("messages", typed);
  }
}

function handleApiResponse(url: string, data: unknown) {
  if (!data || typeof data !== "object") return;
  const obj = data as Record<string, unknown>;

  try {
    // Only intercept items/get when filtered by user (not the main feed)
    if (url.includes("/items/get") && url.includes("user=")) {
      logSync("CS", `Intercepted /items/get: ${(obj.items as unknown[])?.length ?? 0} items`);
      handleItemsGet(obj);
    }
    if (url.includes("/profile/info")) {
      const obj = data as Record<string, unknown>;
      logSync("CS", `Intercepted /profile/info: ${(obj.comments as unknown[])?.length ?? 0} comments`);
      handleProfileInfo(obj);
      // Also backup inbox/messages from profile info if present
      if (obj.messages && Array.isArray(obj.messages)) {
        handleInbox(obj, url);
      }
    }
    if (url.includes("/profile/comments")) {
      logSync("CS", `Intercepted /profile/comments`);
      handleProfileInfo(obj);
    }
    if (url.includes("/bookmarks/get")) {
      logSync("CS", `Intercepted /bookmarks/get`);
      const obj = data as Record<string, unknown>;
      const bookmarks = obj.bookmarks as FilterBookmark[] | undefined;
      if (bookmarks?.length) enqueue("filters", bookmarks);
    }
    if (url.includes("/collections/get")) {
      logSync("CS", `Intercepted /collections/get`);
      const colData = data as Record<string, unknown>;
      const allCols = (colData.collections || colData.curatorCollections) as any[] | undefined;
      if (allCols?.length) {
        const now = Date.now();
        const cols: Collection[] = allCols.map((c: any) => ({
          id: c.id ?? 0,
          name: c.name ?? "",
          keyword: c.keyword ?? "",
          isPublic: !!c.isPublic,
          isDefault: !!c.isDefault,
          isCurated: false,
          syncedAt: now,
        }));
        enqueue("collections", cols);
      }
    }
    if (url.includes("/inbox/")) {
      logSync("CS", `Intercepted inbox: ${url}`);
      handleInbox(obj, url);
    }
  } catch (e) {
    logErr("CS", `handleApiResponse error: ${String(e)}`);
  }
}

// ---- Receive API responses from page-hook ----

window.addEventListener("message", (ev: MessageEvent) => {
  if (ev.source !== window) return;
  const data = ev.data;
  if (!data || data.source !== HOOK_TAG || typeof data.url !== "string") return;
  handleApiResponse(data.url, data.data);
});

// ---- Active Sync Proxy ----

browser.runtime.onMessage.addListener((msg: any) => {
  if (msg.type === "FETCH_API") {
    const { endpoint, params } = msg;
    const url = new URL(`/api${endpoint}`, window.location.origin);
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      });
    }

    return fetch(url.toString(), { credentials: "include" })
      .then((r) => r.json())
      .catch((err) => ({ error: String(err) }));
  }
  return false;
});
