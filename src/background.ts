// pr0Vault — Service Worker (Background)
// Handles all messages, DB operations, search, and export.

import { db } from "./shared/db";
import Fuse from "fuse.js";
import JSZip from "jszip";
import { logSync, logErr } from "./shared/logger";
import { respondAsync } from "./shared/dispatch";
import type {
  VaultMessage,
  VaultResponse,
  SyncProgressMessage,
  SyncCompleteMessage,
} from "./shared/messages";
import type { VaultStats, Comment, Message, ExportData } from "./shared/types";

// ---- Install / Update Handler ----

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    // First install: enable auto-sync by default and trigger initial sync.
    await chrome.storage.local.set({ autoSync: true });
    await chrome.alarms.create("pr0vault-sync", { periodInMinutes: 60 });
    logSync("SW", `Installed v${chrome.runtime.getManifest().version} — auto-sync enabled`);
  } else if (details.reason === "update") {
    // Re-arm alarm if user had auto-sync on (alarms persist but ensure correctness).
    const { autoSync } = await chrome.storage.local.get("autoSync");
    if (autoSync) {
      await chrome.alarms.create("pr0vault-sync", { periodInMinutes: 60 });
    }
    logSync("SW", `Updated to v${chrome.runtime.getManifest().version}`);
  }
});

// ---- Alarm Handler (Auto-Sync) ----

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "pr0vault-sync") {
    logSync("SW", "Auto-Sync triggered");
    handleSyncStart("all").catch((e) => logErr("SW", `Auto-Sync error: ${String(e)}`));
  }
});

// ---- Message Router ----

async function routeMessage(msg: VaultMessage): Promise<VaultResponse> {
  switch (msg.type) {
    case "STORE_BATCH":
      // Bewusste Ausnahme: sofort antworten, DB-Schreibung läuft detached.
      handleStoreBatch(msg.payload).catch((e) =>
        logErr("SW", `StoreBatch error: ${String(e)}`)
      );
      return { success: true };

    case "SYNC_START": {
      logSync("SW", `Sync gestartet: ${msg.scope}`);
      const stats = await handleSyncStart(msg.scope);
      logSync("SW", `Sync fertig: ${JSON.stringify(stats)}`);
      return stats;
    }

    case "QUERY_SEARCH":
      return { results: await handleSearch(msg.query, msg.limit ?? 50) };

    case "GET_STATS":
      return await getStats();

    case "EXPORT":
      return await handleExport(msg.format, msg.scope);

    case "CACHE_THUMB": {
      const binary = Uint8Array.from(atob(msg.blobBase64), (c) =>
        c.charCodeAt(0)
      );
      const blob = new Blob([binary], { type: "image/jpeg" });
      await db.collectionItems
        .where("itemId")
        .equals(msg.itemId)
        .modify({ thumbBlob: blob });
      return { success: true };
    }

    case "GET_COLLECTIONS": {
      const cols = await db.collections.toArray();
      const counts: Record<number, number> = {};
      for (const col of cols) {
        counts[col.id] = await db.collectionItems
          .where("collectionId")
          .equals(col.id)
          .count();
      }
      return { collections: cols, counts };
    }

    case "GET_COLLECTION_ITEMS": {
      const items = await db.collectionItems
        .where("collectionId")
        .equals(msg.collectionId)
        .offset(msg.offset ?? 0)
        .limit(msg.limit ?? 30)
        .toArray();
      const total = await db.collectionItems
        .where("collectionId")
        .equals(msg.collectionId)
        .count();
      const atEnd = (msg.offset ?? 0) + items.length >= total;
      return { items, atEnd };
    }

    default:
      // Unbekannter / nicht hier behandelter Typ: respondAsync hält den Channel
      // (return true) und antwortet mit undefined.
      return;
  }
}

chrome.runtime.onMessage.addListener(
  (msg: VaultMessage, _sender, sendResponse: (r: VaultResponse) => void) =>
    respondAsync(() => routeMessage(msg), msg.type, sendResponse)
);

// ---- Store Batch ----

async function handleStoreBatch(payload: {
  uploads?: import("./shared/types").Upload[];
  comments?: Comment[];
  messages?: Message[];
  filters?: import("./shared/types").FilterBookmark[];
  collections?: import("./shared/types").Collection[];
  collectionItems?: import("./shared/types").CollectionItem[];
}) {
  const now = Date.now();

  if (payload.uploads?.length) {
    const items = payload.uploads.map((u) => ({ ...u, syncedAt: now }));
    await db.uploads.bulkPut(items);
    await db.meta.put({ key: "lastSync", value: now });
    logSync("SW", `Stored ${items.length} uploads`);
  }
  if (payload.comments?.length) {
    await db.comments.bulkPut(payload.comments);
    await db.meta.put({ key: "lastSync", value: now });
    invalidateFuseCache();
    logSync("SW", `Stored ${payload.comments.length} comments`);
  }
  if (payload.messages?.length) {
    await db.messages.bulkPut(payload.messages);
    await db.meta.put({ key: "lastSync", value: now });
    invalidateFuseCache();
    logSync("SW", `Stored ${payload.messages.length} messages`);
  }
  if (payload.filters?.length) {
    await db.filters.bulkPut(payload.filters);
    await db.meta.put({ key: "lastSync", value: now });
    logSync("SW", `Stored ${payload.filters.length} filters`);
  }
  if (payload.collections?.length) {
    await db.collections.bulkPut(payload.collections);
    await db.meta.put({ key: "lastSync", value: now });
    logSync("SW", `Stored ${payload.collections.length} collections`);
  }
  if (payload.collectionItems?.length) {
    // Merge: preserve existing thumbBlobs
    const existing = await db.collectionItems
      .where("[collectionId+itemId]")
      .anyOf(payload.collectionItems.map(ci => [ci.collectionId, ci.itemId] as [number, number]))
      .toArray();
    const existingMap = new Map(existing.map(e => [`${e.collectionId}_${e.itemId}`, e]));
    const merged = payload.collectionItems.map(ci => {
      const prev = existingMap.get(`${ci.collectionId}_${ci.itemId}`);
      return prev?.thumbBlob ? { ...ci, thumbBlob: prev.thumbBlob } : ci;
    });
    await db.collectionItems.bulkPut(merged);
    await db.meta.put({ key: "lastSync", value: now });
    logSync("SW", `Stored ${payload.collectionItems.length} collection items`);
  }
}

// ---- Active Sync ----

async function sendSyncProgress(
  scope: string,
  page: number,
  total: number,
  newItems: number,
  done = false,
) {
  const msg: SyncProgressMessage = {
    type: "SYNC_PROGRESS",
    scope,
    page,
    total,
    newItems,
    done,
  };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

async function getPr0Cookies(): Promise<string> {
  const [pp, me] = await Promise.all([
    chrome.cookies.get({ url: "https://pr0gramm.com", name: "pp" }),
    chrome.cookies.get({ url: "https://pr0gramm.com", name: "me" }),
  ]);
  if (!pp || !me) throw new Error("Nicht eingeloggt — bitte pr0gramm.com besuchen.");
  return `pp=${pp.value}; me=${me.value}`;
}

async function getUsername(): Promise<string> {
  try {
    const meCookie = await chrome.cookies.get({ url: "https://pr0gramm.com", name: "me" });
    if (meCookie) {
      const decoded = JSON.parse(decodeURIComponent(meCookie.value));
      return decoded.n || "";
    }
  } catch { /* fall through */ }
  return "me";
}

async function fetchAPI(
  endpoint: string,
  params: Record<string, string> = {}
): Promise<unknown> {
  // Try direct fetch with cookies first
  try {
    const cookie = await getPr0Cookies();
    const url = new URL(`/api${endpoint}`, "https://pr0gramm.com");
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });
    const resp = await fetch(url.toString(), {
      headers: { Cookie: cookie },
    });
    if (resp.ok) return resp.json();
  } catch {
    // Fall through to CS proxy
  }

  // Fallback: use content script on active pr0gramm tab
  const tabs = await chrome.tabs.query({ url: "https://pr0gramm.com/*" });
  const tab = tabs[0];
  if (tab?.id) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id!, { type: "FETCH_API", endpoint, params }, (resp) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(resp);
      });
    });
  }

  throw new Error("Kein pr0gramm-Tab aktiv und kein Cookie verfügbar.");
}

async function syncComments(me: string, fromPopup: boolean) {
  const lastMeta = await db.meta.get("lastCommentTs");
  const lastTs = (lastMeta?.value as number) || 0;
  const isIncremental = lastTs > 0;

  // Pagination state — MUST live outside the loop, otherwise we re-fetch page 1 forever.
  let after = isIncremental ? lastTs : 0;
  let before = isIncremental ? 0 : Math.floor(Date.now() / 1000);
  let totalNew = 0;
  let page = 0;
  const MAX_PAGES = 2000; // ~100k comments at 50/page

  logSync("SW", `syncComments start (incremental=${isIncremental}, lastTs=${lastTs})`);

  while (page < MAX_PAGES) {
    const params: Record<string, string> = { name: me, flags: "15" };
    if (isIncremental) {
      params.after = String(after);
    } else {
      params.before = String(before);
    }

    const data = (await fetchAPI("/profile/comments", params)) as Record<string, unknown> | null;
    if (!data) { logSync("SW", `syncComments: empty response page ${page}`); break; }
    if (data.error) { logErr("SW", `syncComments API error: ${String(data.error)}`); break; }

    const comments = data.comments as Comment[] | undefined;
    if (!comments || comments.length === 0) { logSync("SW", `syncComments: no more comments at page ${page}`); break; }

    // Dedupe against existing
    const knownIds = new Set(
      (await db.comments.where("id").anyOf(comments.map(c => c.id)).toArray()).map(c => c.id)
    );
    const newComments = comments.filter(c => !knownIds.has(c.id));

    if (newComments.length > 0) {
      await db.comments.bulkPut(newComments);
      await db.meta.put({ key: "lastSync", value: Date.now() });
      invalidateFuseCache();
      totalNew += newComments.length;
    }

    page++;

    // Track newest seen timestamp for next incremental run (monotonic — never regress)
    const maxTs = Math.max(...comments.map(c => c.created));
    const minTs = Math.min(...comments.map(c => c.created));
    const prevMaxMeta = await db.meta.get("lastCommentTs");
    const prevMax = (prevMaxMeta?.value as number) || 0;
    if (maxTs > prevMax) await db.meta.put({ key: "lastCommentTs", value: maxTs });

    if (fromPopup) sendSyncProgress("comments", page, 0, totalNew);

    if (isIncremental) {
      // Walk forward in time until we've caught up
      if (!data.hasNewer) break;
      // If a whole page is already known and we have nothing newer, we're done.
      if (newComments.length === 0) break;
      after = maxTs;
    } else {
      // Walk backward in time through ALL history. Don't stop early just because
      // one page contains already-known comments — there could be gaps from a
      // previous interrupted sync (e.g. MAX_PAGES hit).
      if (!data.hasOlder) break;
      const nextBefore = minTs;
      // Safety: detect when pagination is not advancing (would loop forever).
      if (nextBefore >= before) {
        logErr("SW", `syncComments: pagination not advancing (before=${before}, nextBefore=${nextBefore}) — stop`);
        break;
      }
      before = nextBefore;
    }

    await new Promise(r => setTimeout(r, 300));
  }

  if (page >= MAX_PAGES) logErr("SW", `syncComments: hit MAX_PAGES safety stop`);
  logSync("SW", `syncComments done: ${totalNew} new (pages: ${page})`);
  return totalNew;
}

async function syncUploads(me: string, fromPopup: boolean) {
  const lastMeta = await db.meta.get("lastUploadId");
  const lastId = (lastMeta?.value as number) || 0;
  const isIncremental = lastId > 0;

  let newer: number | undefined = isIncremental ? lastId : undefined;
  let older: number | undefined = undefined;
  let totalNew = 0;
  let page = 0;
  const MAX_PAGES = 1000;

  logSync("SW", `syncUploads start (incremental=${isIncremental}, lastId=${lastId})`);

  while (page < MAX_PAGES) {
    const params: Record<string, string> = { user: me, flags: "15" };
    if (newer !== undefined) params.newer = String(newer);
    if (older !== undefined) params.older = String(older);

    const data = (await fetchAPI("/items/get", params)) as Record<string, unknown> | null;
    if (!data) { logSync("SW", `syncUploads: empty page ${page}`); break; }
    if (data.error) { logErr("SW", `syncUploads API error: ${String(data.error)}`); break; }

    const items = data.items as import("./shared/types").Upload[] | undefined;
    if (!items || items.length === 0) { logSync("SW", `syncUploads: no items at page ${page}`); break; }

    const knownIds = new Set(
      (await db.uploads.where("id").anyOf(items.map(i => i.id)).toArray()).map(i => i.id)
    );
    const newItems = items.filter(i => !knownIds.has(i.id));

    if (isIncremental && newItems.length === 0) {
      logSync("SW", `syncUploads: caught up (all ${items.length} known)`);
      break;
    }

    if (newItems.length > 0) {
      const now = Date.now();
      const synced = newItems.map((it) => ({ ...it, syncedAt: now }));
      await db.uploads.bulkPut(synced);
      await db.meta.put({ key: "lastSync", value: now });
      totalNew += newItems.length;
    }
    page++;

    const maxId = Math.max(...items.map(i => i.id));
    const minId = Math.min(...items.map(i => i.id));
    const prevMaxMeta = await db.meta.get("lastUploadId");
    const prevMax = (prevMaxMeta?.value as number) || 0;
    if (maxId > prevMax) await db.meta.put({ key: "lastUploadId", value: maxId });

    if (fromPopup) sendSyncProgress("uploads", page, 0, totalNew);

    if (data.atEnd) break;

    if (isIncremental) {
      newer = maxId;
    } else {
      older = minId; // walk backward through history
    }

    await new Promise(r => setTimeout(r, 300));
  }

  if (page >= MAX_PAGES) logErr("SW", `syncUploads: hit MAX_PAGES safety stop`);
  logSync("SW", `syncUploads done: ${totalNew} new (pages: ${page})`);
  return totalNew;
}

async function syncFilters() {
  const data = (await fetchAPI("/bookmarks/get")) as Record<string, unknown> | null;
  if (!data) { logSync("SW", `syncFilters: empty response`); return 0; }
  if (data.error) { logErr("SW", `syncFilters API error: ${String(data.error)}`); return 0; }
  const bookmarks = data.bookmarks as import("./shared/types").FilterBookmark[] | undefined;
  if (!bookmarks || bookmarks.length === 0) { logSync("SW", `syncFilters: no bookmarks`); return 0; }
  const now = Date.now();
  const synced = bookmarks.map((b) => ({ ...b, syncedAt: now }));
  await db.filters.bulkPut(synced);
  logSync("SW", `syncFilters: stored ${synced.length} bookmarks`);
  return synced.length;
}

async function syncCollections() {
  const data = (await fetchAPI("/collections/get")) as Record<string, unknown> | null;
  if (!data) { logSync("SW", `syncCollections: empty response`); return 0; }
  if (data.error) { logErr("SW", `syncCollections API error: ${String(data.error)}`); return 0; }

  const raw = data.collections as any[] | undefined;
  const now = Date.now();
  let stored = 0;

  if (raw?.length) {
    const synced: import("./shared/types").Collection[] = raw.map((c: any) => ({
      id: c.id ?? 0,
      name: c.name ?? "",
      keyword: c.keyword ?? "",
      isPublic: !!c.isPublic,
      isDefault: !!c.isDefault,
      isCurated: false,
      syncedAt: now,
    }));
    await db.collections.bulkPut(synced);
    stored += synced.length;
    logSync("SW", `syncCollections: stored ${synced.length} own collections`);
  } else {
    logSync("SW", `syncCollections: no own collections in response`);
  }

  // Kuratierte Collections (API liefert mal Array, mal verschiedene Keys)
  const curatorCollections = (data.curatorCollections ?? data.curatedCollections) as any[] | undefined;
  if (Array.isArray(curatorCollections) && curatorCollections.length > 0) {
    const curated: import("./shared/types").Collection[] = curatorCollections.map((c: any) => ({
      id: c.id ?? 0,
      name: c.name ?? "",
      keyword: c.keyword ?? "",
      isPublic: !!c.isPublic,
      isDefault: false,
      isCurated: true,
      syncedAt: now,
    }));
    await db.collections.bulkPut(curated);
    stored += curated.length;
    logSync("SW", `syncCollections: stored ${curated.length} curated collections`);
  }

  return stored;
}

async function syncCollectionItems(fromPopup: boolean) {
  const collections = await db.collections.toArray();
  const me = await getUsername();
  let totalNew = 0;
  const MAX_PAGES = 500;

  logSync("SW", `syncCollectionItems start: ${collections.length} collections (user=${me})`);

  for (const col of collections) {
    if (!col.keyword) {
      logSync("SW", `syncCollectionItems: skip "${col.name}" (no keyword)`);
      continue;
    }
    if (col.isCurated) {
      // Curator-collections need different params; skip for now to avoid 400s.
      logSync("SW", `syncCollectionItems: skip curated "${col.name}"`);
      continue;
    }

    const metaKey = `lastCollectionItemId_${col.id}`;
    const lastMeta = await db.meta.get(metaKey);
    const lastId = (lastMeta?.value as number) || 0;
    const isIncremental = lastId > 0;

    let newer: number | undefined = isIncremental ? lastId : undefined;
    let older: number | undefined = undefined;
    let colNew = 0;
    let page = 0;

    while (page < MAX_PAGES) {
      // CRITICAL: user param is required, otherwise pr0gramm returns items from
      // ALL users matching the keyword (e.g. "favoriten" = public favorites lists worldwide).
      const params: Record<string, string> = {
        flags: "15",
        user: me,
        collection: col.keyword,
      };
      if (newer !== undefined) params.newer = String(newer);
      if (older !== undefined) params.older = String(older);

      try {
        const data = (await fetchAPI("/items/get", params)) as Record<string, unknown> | null;
        if (!data) { logSync("SW", `syncCollectionItems[${col.name}]: empty page ${page}`); break; }
        if (data.error) { logErr("SW", `syncCollectionItems[${col.name}] API error: ${String(data.error)}`); break; }

        const items = data.items as any[] | undefined;
        if (!items || items.length === 0) { logSync("SW", `syncCollectionItems[${col.name}]: no items at page ${page}`); break; }

        const now = Date.now();
        const collectionItems: import("./shared/types").CollectionItem[] = items.map((it: any) => ({
          collectionId: col.id,
          itemId: it.id,
          userId: it.userId ?? 0,
          user: it.user ?? "",
          created: it.created ?? 0,
          image: it.image ?? "",
          thumb: it.thumb ?? "",
          flags: it.flags ?? 0,
          mark: it.mark ?? 0,
          up: it.up ?? 0,
          down: it.down ?? 0,
          tags: (it.tags ?? []) as import("./shared/types").Tag[],
          syncedAt: now,
        }));

        // Dedupe / merge with existing thumbBlobs
        const existing = await db.collectionItems
          .where("[collectionId+itemId]")
          .anyOf(collectionItems.map(ci => [ci.collectionId, ci.itemId] as [number, number]))
          .toArray();
        const existingMap = new Map(existing.map(e => [`${e.collectionId}_${e.itemId}`, e]));
        const knownCount = existing.length;
        const merged = collectionItems.map(ci => {
          const prev = existingMap.get(`${ci.collectionId}_${ci.itemId}`);
          return prev?.thumbBlob ? { ...ci, thumbBlob: prev.thumbBlob } : ci;
        });

        if (isIncremental && knownCount === items.length) {
          logSync("SW", `syncCollectionItems[${col.name}]: caught up at page ${page}`);
          break;
        }

        await db.collectionItems.bulkPut(merged);
        const trulyNew = items.length - knownCount;
        colNew += trulyNew;
        totalNew += trulyNew;
        page++;

        const maxId = Math.max(...items.map(i => i.id));
        const minId = Math.min(...items.map(i => i.id));
        const prevMaxMeta = await db.meta.get(metaKey);
        const prevMax = (prevMaxMeta?.value as number) || 0;
        if (maxId > prevMax) await db.meta.put({ key: metaKey, value: maxId });
        await db.meta.put({ key: "lastSync", value: now });

        if (fromPopup && page <= 3) {
          sendSyncProgress(`collection:${col.name}`, page, 0, totalNew);
        }

        if (data.atEnd) break;

        if (isIncremental) {
          newer = maxId;
        } else {
          older = minId;
        }

        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        logErr("SW", `Collection sync error (${col.name}): ${String(e)}`);
        break;
      }
    }

    if (page >= MAX_PAGES) logErr("SW", `syncCollectionItems[${col.name}]: hit MAX_PAGES safety stop`);
    logSync("SW", `syncCollectionItems[${col.name}]: ${colNew} new (pages: ${page})`);
  }

  logSync("SW", `syncCollectionItems done: ${totalNew} total new items`);
  return totalNew;
}

async function syncInbox(_me: string) {
  const lastMeta = await db.meta.get("lastInboxTs");
  const lastTs = (lastMeta?.value as number) || 0;
  const isIncremental = lastTs > 0;

  let older: number | undefined = undefined;
  let totalNew = 0;
  let page = 0;
  const MAX_PAGES = 1000; // ~100k messages at 100/page

  logSync("SW", `syncInbox start (incremental=${isIncremental}, lastTs=${lastTs})`);

  while (page < MAX_PAGES) {
    const params: Record<string, string> = {};
    if (older !== undefined) params.older = String(older);

    const data = (await fetchAPI("/inbox/all", params)) as Record<string, unknown> | null;
    if (!data) { logSync("SW", `syncInbox: empty page ${page}`); break; }
    if (data.error) { logErr("SW", `syncInbox API error: ${String(data.error)}`); break; }

    const messages = data.messages as import("./shared/types").Message[] | undefined;
    if (!messages || messages.length === 0) { logSync("SW", `syncInbox: no more messages at page ${page}`); break; }

    // Dedupe + incremental cutoff
    const knownIds = new Set(
      (await db.messages.where("id").anyOf(messages.map(m => m.id)).toArray()).map(m => m.id)
    );
    const filtered = messages.filter(m =>
      !knownIds.has(m.id) && (!isIncremental || m.created > lastTs)
    );

    if (filtered.length > 0) {
      const now = Date.now();
      const synced = filtered.map((m) => ({ ...m, syncedAt: now }));
      await db.messages.bulkPut(synced);
      await db.meta.put({ key: "lastSync", value: now });
      invalidateFuseCache();
      totalNew += synced.length;
    }

    page++;

    // Stop conditions: API end OR pagination not advancing
    if (data.atEnd) break;
    const nextOlder = messages[messages.length - 1].created;
    if (older !== undefined && nextOlder >= older) {
      logErr("SW", `syncInbox: pagination not advancing (older=${older}, next=${nextOlder}) — stop`);
      break;
    }
    // Incremental: stop when an entire page is older than our cutoff AND known.
    if (isIncremental && filtered.length === 0 && messages.every(m => m.created <= lastTs)) {
      logSync("SW", `syncInbox: reached incremental cutoff at page ${page}`);
      break;
    }

    older = nextOlder;
    await new Promise(r => setTimeout(r, 300));
  }

  if (page >= MAX_PAGES) logErr("SW", `syncInbox: hit MAX_PAGES safety stop`);

  // Track highest seen timestamp
  if (totalNew > 0) {
    const maxRow = await db.messages.orderBy("created").last();
    if (maxRow) await db.meta.put({ key: "lastInboxTs", value: maxRow.created });
  }

  logSync("SW", `syncInbox done: ${totalNew} new (pages: ${page})`);
  return totalNew;
}

async function handleSyncStart(scope: string): Promise<VaultStats> {
  // Get username from cookie
  const meCookie = await chrome.cookies.get({
    url: "https://pr0gramm.com",
    name: "me",
  });
  if (!meCookie) throw new Error("Nicht eingeloggt — bitte pr0gramm.com besuchen.");

  const decoded = JSON.parse(decodeURIComponent(meCookie.value));
  const me: string = decoded.n || "";

  if (!me) throw new Error("Username nicht gefunden.");

  const doAll = scope === "all";
  const doUploads = doAll || scope === "uploads";
  const doComments = doAll || scope === "comments";
  const doFilters = doAll || scope === "filters";
  const doCollections = doAll || scope === "collections";
  const doInbox = doAll || scope === "inbox";

  if (doUploads) {
    try { await syncUploads(me, true); }
    catch (e) { logErr("SW", `syncUploads failed: ${String(e)}`); }
  }
  if (doComments) {
    try { await syncComments(me, true); }
    catch (e) { logErr("SW", `syncComments failed: ${String(e)}`); }
  }
  if (doFilters) {
    try { await syncFilters(); }
    catch (e) { logErr("SW", `syncFilters failed: ${String(e)}`); }
  }
  if (doCollections) {
    try { await syncCollections(); }
    catch (e) { logErr("SW", `syncCollections failed: ${String(e)}`); }
    try { await syncCollectionItems(true); }
    catch (e) { logErr("SW", `syncCollectionItems failed: ${String(e)}`); }
  }
  if (doInbox) {
    try { await syncInbox(me); }
    catch (e) { logErr("SW", `syncInbox failed: ${String(e)}`); }
  }

  const stats = await getStats();
  const complete: SyncCompleteMessage = { type: "SYNC_COMPLETE", stats };
  chrome.runtime.sendMessage(complete).catch(() => {});

  return stats;
}

// ---- Search ----

// Cached Fuse instance — rebuilt only after sync writes new comments/messages.
type SearchableItem = (Comment | Message) & { _type: "comment" | "message" };
let fuseCache: { fuse: Fuse<SearchableItem>; builtAt: number } | null = null;
let searchableCount = 0;

function invalidateFuseCache() {
  fuseCache = null;
}

async function buildFuse(): Promise<Fuse<SearchableItem>> {
  const [comments, messages] = await Promise.all([
    db.comments.toArray(),
    db.messages.toArray(),
  ]);
  const all: SearchableItem[] = [
    ...comments.map((c) => ({ ...c, _type: "comment" as const })),
    ...messages.map((m) => ({ ...m, _type: "message" as const })),
  ];
  searchableCount = all.length;
  return new Fuse(all, {
    keys: ["content", "message"],
    threshold: 0.4,
    minMatchCharLength: 2,
    includeScore: true,
    includeMatches: true,
  });
}

async function handleSearch(query: string, limit: number) {
  if (!fuseCache) {
    const fuse = await buildFuse();
    fuseCache = { fuse, builtAt: Date.now() };
    logSync("SW", `Fuse index built (${searchableCount} items)`);
  }
  const fuseResults = fuseCache.fuse.search(query).slice(0, limit);
  return fuseResults.map((r) => ({ ...r, score: r.score ?? 0 }));
}

// ---- Stats ----

async function getStats(): Promise<VaultStats> {
  const stats = await db.getStats();
  // Estimate storage — very rough
  const storageBytes = stats.uploads * 512 + stats.comments * 256;
  return { ...stats, storageBytes };
}

// ---- Export ----

async function handleExport(
  format: "json" | "zip",
  scope: "all" | "comments" | "uploads"
): Promise<{ success: boolean; filename?: string; downloadId?: number; error?: string }> {
  try {
    const uploads = scope === "all" || scope === "uploads" ? await db.uploads.toArray() : [];
    const comments = scope === "all" || scope === "comments" ? await db.comments.toArray() : [];
    const filters = scope === "all" ? await db.filters.toArray() : [];
    const collections = scope === "all" ? await db.collections.toArray() : [];
    const messages = scope === "all" ? await db.messages.toArray() : [];

    const collectionItems = scope === "all"
      ? await db.collectionItems.toArray()
      : [];

    const data: ExportData = {
      exportDate: new Date().toISOString(),
      pr0VaultVersion: "0.1.0",
      user: await getUsername(),
      uploads: uploads.map(({ thumbBlob, fullBlob, ...rest }) => rest),
      comments,
      filters,
      collections: collections.map((c) => ({
        collection: c,
        items: collectionItems.filter(ci => ci.collectionId === c.id),
      })),
      messages,
    };

    const dateStr = new Date().toISOString().slice(0, 10);

    if (format === "json") {
      // MV3 service workers have no URL.createObjectURL — build a data URL directly.
      const json = JSON.stringify(data, null, 2);
      const url = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;

      const downloadId = await chrome.downloads.download({
        url,
        filename: `pr0vault-export-${dateStr}.json`,
        saveAs: true,
      });

      return { success: true, filename: `pr0vault-export-${dateStr}.json`, downloadId };
    } else {
      // ZIP export
      const zip = new JSZip();

      zip.file("data.json", JSON.stringify(data, null, 2));

      // Add thumbnails if available
      for (const upload of uploads) {
        if (upload.thumbBlob) {
          zip.file(
            `uploads/${upload.id}.jpg`,
            upload.thumbBlob,
            { binary: true }
          );
        }
      }

      const readme = `pr0Vault Export\n==============\nDatum: ${data.exportDate}\nUser: ${data.user}\nUploads: ${data.uploads.length}\nComments: ${data.comments.length}\n`;
      zip.file("README.txt", readme);

      // Generate base64 → data URL instead of createObjectURL (unavailable in the SW).
      const base64 = await zip.generateAsync({ type: "base64" });
      const url = `data:application/zip;base64,${base64}`;

      const downloadId = await chrome.downloads.download({
        url,
        filename: `pr0vault-export-${dateStr}.zip`,
        saveAs: true,
      });

      return { success: true, filename: `pr0vault-export-${dateStr}.zip`, downloadId };
    }
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
