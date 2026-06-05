import {browser} from "../shared/browser";
import {signal} from "@preact/signals";
import {useCallback, useEffect} from "preact/hooks";

const query = signal("");
const results = signal<{ score: number; item: { content: string; itemId?: number; name?: string; created?: number; _type?: string }; matches?: unknown[] }[]>([]);
const searching = signal(false);
const error = signal("");

let debounceTimer: ReturnType<typeof setTimeout>;

export function Search() {
  const doSearch = useCallback(() => {
    const q = query.value.trim();
    if (q.length < 2) {
      results.value = [];
      return;
    }

    searching.value = true;
    error.value = "";

    browser.runtime.sendMessage(
      { type: "QUERY_SEARCH", query: q, limit: 50 }
    ).then((response: any) => {
      searching.value = false;
      if (response?.results) {
        results.value = response.results as typeof results.value;
      } else {
        results.value = [];
      }
    }).catch((err) => {
      searching.value = false;
      error.value = String(err);
    });
  }, []);

  useEffect(() => {
    clearTimeout(debounceTimer);
    if (query.value.length >= 2) {
      debounceTimer = setTimeout(doSearch, 200);
    } else {
      results.value = [];
    }
  }, [query.value]);

  function openItem(itemId?: number, commentId?: number) {
    if (!itemId) return;
    const url = commentId
      ? `https://pr0gramm.com/new/${itemId}:comment${commentId}`
      : `https://pr0gramm.com/new/${itemId}`;
    browser.tabs.create({ url });
  }

  function highlightText(text: string, matches: unknown[] | undefined): string {
    if (!matches || matches.length === 0) return text;

    // Simple highlight: wrap matched regions in <mark>
    // For now, just return text — full highlighting is complex
    return text;
  }

  return (
    <div class="search-panel">
      <input
        type="text"
        class="search-input"
        placeholder="Comments & Nachrichten durchsuchen…"
        value={query.value}
        onInput={(e) => (query.value = (e.target as HTMLInputElement).value)}
        autoFocus
      />

      {query.value.length === 1 && (
        <p class="hint">Mindestens 2 Zeichen eingeben.</p>
      )}

      {searching.value && <div class="searching">Suche…</div>}

      {error.value && <div class="error-state">{error.value}</div>}

      {!searching.value &&
        query.value.length >= 2 &&
        results.value.length === 0 && (
          <p class="hint">Keine Ergebnisse für "{query.value}".</p>
        )}

      <div class="results">
        {results.value.map((r, i) => {
          const item = r.item as any;
          const itemId = item.itemId as number | undefined;
          const created = item.created as number | undefined;
          const dateStr = created
            ? new Date(created * 1000).toLocaleDateString("de-DE")
            : "";
          const text = String(item.content ?? item.message ?? "");
          const author = String(item.name ?? "");

          return (
            <div
              key={i}
              class="result-item"
              onClick={() => openItem(itemId, item.id as number | undefined)}
            >
              <div class="result-content">{text}</div>
              <div class="result-meta">
                {dateStr && <span>{dateStr}</span>}
                {author && <span>{author}</span>}
              </div>
            </div>
          );
        })}
      </div>

      {results.value.length >= 50 && (
        <p class="hint">Zeige Top 50 von vielen Ergebnissen.</p>
      )}
    </div>
  );
}
