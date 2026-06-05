import { signal, effect } from "@preact/signals";
import { Dashboard } from "./Dashboard";
import { Search } from "./Search";
import { ExportPanel } from "./Export";
import { CollectionsPanel } from "./Collections";
import { LogPanel } from "./Log";
import type { VaultStats } from "../shared/types";
import { isErrorResponse } from "../shared/dispatch";
import { logErr } from "../shared/logger";
import type {
  SyncProgressMessage,
  SyncCompleteMessage,
} from "../shared/messages";

const activeTab = signal<"dashboard" | "search" | "export" | "collections" | "log">("dashboard");
const stats = signal<VaultStats>({
  uploads: 0,
  comments: 0,
  filters: 0,
  collections: 0,
  messages: 0,
  storageBytes: 0,
  lastSync: null,
});
const syncState = signal<"idle" | "syncing" | "error">("idle");
const syncProgress = signal<SyncProgressMessage | null>(null);

function refreshStats() {
  chrome.runtime.sendMessage({ type: "GET_STATS" }, (response) => {
    if (chrome.runtime.lastError) return;
    if (isErrorResponse(response)) {
      logErr("Popup", `GET_STATS fehlgeschlagen: ${response.error}`);
      return; // Default-Nullen behalten → kein Crash, sauberer Empty-State
    }
    if (response) stats.value = response as VaultStats;
  });
}

// Listen for progress/completion from service worker via runtime
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "SYNC_PROGRESS") {
    syncProgress.value = msg as SyncProgressMessage;
  }
  if (msg.type === "SYNC_COMPLETE") {
    syncState.value = "idle";
    syncProgress.value = null;
    stats.value = (msg as SyncCompleteMessage).stats;
  }
});

// Initial load
refreshStats();

// Load and apply accent color from settings
chrome.storage.local.get("accentColor", (data) => {
  if (data.accentColor) {
    document.documentElement.style.setProperty("--accent-blue", data.accentColor);
  }
});

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

export function App() {
  return (
    <div class="app">
      <header class="header">
        <img
          src="../../icons/icon48.png"
          alt="pr0Vault"
          class="logo"
          width="24"
          height="24"
        />
        <span class="title">pr0Vault</span>
        <button class="settings-btn" title="Optionen" onClick={() => chrome.runtime.openOptionsPage()}>⚙</button>
        <span class="storage">{formatBytes(stats.value.storageBytes)}</span>
        <span class="sync-indicator" title={formatDate(stats.value.lastSync)}>
          {syncState.value === "syncing" ? "⚡" : "●"}
        </span>
      </header>

      <nav class="tabs">
        <button
          class={activeTab.value === "dashboard" ? "active" : ""}
          onClick={() => (activeTab.value = "dashboard")}
        >
          Dashboard
        </button>
        <button
          class={activeTab.value === "search" ? "active" : ""}
          onClick={() => (activeTab.value = "search")}
        >
          Suche
        </button>
        <button
          class={activeTab.value === "export" ? "active" : ""}
          onClick={() => (activeTab.value = "export")}
        >
          Export
        </button>
        <button
          class={activeTab.value === "collections" ? "active" : ""}
          onClick={() => (activeTab.value = "collections")}
        >
          Sammlungen
        </button>
        <button
          class={activeTab.value === "log" ? "active" : ""}
          onClick={() => (activeTab.value = "log")}
        >
          Log
        </button>
      </nav>

      <main>
        {activeTab.value === "dashboard" && (
          <Dashboard
            stats={stats.value}
            syncState={syncState}
            syncProgress={syncProgress.value}
          />
        )}
        {activeTab.value === "search" && <Search />}
        {activeTab.value === "export" && <ExportPanel />}
        {activeTab.value === "collections" && <CollectionsPanel />}
        {activeTab.value === "log" && <LogPanel />}
      </main>
    </div>
  );
}
