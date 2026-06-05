import { signal } from "@preact/signals";
import type { VaultStats } from "../shared/types";
import type { SyncProgressMessage } from "../shared/messages";
import { isErrorResponse } from "../shared/dispatch";

interface Props {
  stats: VaultStats;
  syncState: { value: "idle" | "syncing" | "error" };
  syncProgress: SyncProgressMessage | null;
}

const autoSync = signal(false);

// Load auto-sync setting
chrome.storage.local.get("autoSync", (d) => { autoSync.value = !!d.autoSync; });

function toggleAutoSync() {
  autoSync.value = !autoSync.value;
  chrome.storage.local.set({ autoSync: autoSync.value });
  // Create/clear periodic alarm
  if (autoSync.value) {
    chrome.alarms.create("pr0vault-sync", { periodInMinutes: 60 });
  } else {
    chrome.alarms.clear("pr0vault-sync");
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ts: number | null): string {
  if (!ts) return "nie";
  return new Date(ts).toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const SCOPE_LABELS: Record<string, string> = {
  uploads: "Hochlads",
  comments: "Kommentare",
  filters: "Filter",
  collections: "Sammlungen",
  inbox: "Nachrichten",
  all: "alles",
};

export function Dashboard({ stats, syncState, syncProgress }: Props) {
  const noData =
    stats.uploads === 0 &&
    stats.comments === 0 &&
    stats.filters === 0 &&
    stats.collections === 0 &&
    stats.messages === 0;

  async function startSync() {
    syncState.value = "syncing";
    try {
      const response = await chrome.runtime.sendMessage({
        type: "SYNC_START",
        scope: "all",
      });
      if (isErrorResponse(response)) {
        syncState.value = "error";
      } else {
        syncState.value = "idle";
      }
    } catch {
      syncState.value = "error";
    }
  }

  return (
    <div class="dashboard">
      {noData && syncState.value !== "syncing" && (
        <div class="empty-state">
          <p>Noch keine Daten.</p>
          <p class="hint">
            Öffne pr0gramm oder klick <strong>Synchronisieren</strong>.
          </p>
        </div>
      )}

      {syncState.value === "syncing" && (
        <div class="sync-progress">
          <div class="progress-bar">
            <div class="progress-fill" />
          </div>
          {syncProgress ? (
            <p class="progress-text">
              Synce {SCOPE_LABELS[syncProgress.scope] || syncProgress.scope}
              {syncProgress.page > 0 && ` (Seite ${syncProgress.page})`}
              {syncProgress.newItems > 0 && ` – ${syncProgress.newItems.toLocaleString()} neu`}
            </p>
          ) : (
            <p class="progress-text">Sync läuft…</p>
          )}
        </div>
      )}

      {syncState.value === "error" && (
        <div class="error-state">
          <p>Sync fehlgeschlagen.</p>
          <p class="hint">Ist pr0gramm.com geöffnet?</p>
        </div>
      )}

      <div class="stats-grid">
        <div class="stat">
          <span class="stat-value">{stats.uploads.toLocaleString()}</span>
          <span class="stat-label">Hochlads</span>
        </div>
        <div class="stat">
          <span class="stat-value">{stats.comments.toLocaleString()}</span>
          <span class="stat-label">Kommentare</span>
        </div>
        <div class="stat">
          <span class="stat-value">{stats.filters.toLocaleString()}</span>
          <span class="stat-label">Filter</span>
        </div>
        <div class="stat">
          <span class="stat-value">{stats.collections.toLocaleString()}</span>
          <span class="stat-label">Sammlungen</span>
        </div>
        <div class="stat">
          <span class="stat-value">{stats.messages.toLocaleString()}</span>
          <span class="stat-label">Nachrichten</span>
        </div>
        <div class="stat">
          <span class="stat-value">{formatBytes(stats.storageBytes)}</span>
          <span class="stat-label">Speicher</span>
        </div>
      </div>

      <div class="color-bar">
        <span class="color-bar-label">Farbe</span>
        {["#008fff","#1db992","#bfbc06","#f7c516","#fc8833","#ee4d2e","#d23c22","#ff0082"].map(c => (
          <span
            class="color-dot"
            style={`background:${c}`}
            title={c}
            onClick={() => {
              chrome.storage.local.set({ accentColor: c });
              document.documentElement.style.setProperty("--accent-blue", c);
            }}
          />
        ))}
      </div>

      <div class="sync-controls">
        <button
          class="btn primary sync-main"
          onClick={startSync}
          disabled={syncState.value === "syncing"}
        >
          {syncState.value === "syncing" ? "Synchronisiere…" : "Synchronisieren"}
        </button>

        <label class="auto-sync-toggle" title="Hält Backup automatisch aktuell (alle 60 Min, nur neue Inhalte)">
          <input
            type="checkbox"
            checked={autoSync.value}
            onChange={toggleAutoSync}
          />
          <span>Auto-Sync</span>
        </label>
      </div>

      <div class="last-sync">
        Letzter Sync: {formatDate(stats.lastSync)}
      </div>
    </div>
  );
}
