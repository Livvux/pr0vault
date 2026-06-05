import {browser} from "../shared/browser";
import {signal} from "@preact/signals";

const format = signal<"json" | "zip">("json");
const scope = signal<"all" | "comments" | "uploads">("all");
const exporting = signal(false);
const exportResult = signal<{ success: boolean; filename?: string; downloadId?: number; error?: string } | null>(null);
const openingFolder = signal(false);

export function ExportPanel() {
  async function doExport() {
    exporting.value = true;
    exportResult.value = null;

    try {
      const response = await browser.runtime.sendMessage({
        type: "EXPORT",
        format: format.value,
        scope: scope.value,
      });
      exportResult.value = response as any;
    } catch (err) {
      exportResult.value = { success: false, error: String(err) };
    } finally {
      exporting.value = false;
    }
  }

  function openFolder() {
    const downloadId = exportResult.value?.downloadId;
    if (downloadId != null) {
      openingFolder.value = true;
      chrome.downloads.show(downloadId);
      setTimeout(() => (openingFolder.value = false), 1000);
    }
  }

  return (
    <div class="export-panel">
      <div class="form-group">
        <label class="form-label">Format</label>
        <div class="radio-group">
          <label class="radio">
            <input
              type="radio"
              name="format"
              value="json"
              checked={format.value === "json"}
              onChange={() => (format.value = "json")}
            />
            <span>JSON (Metadaten, ~2-5 MB)</span>
          </label>
          <label class="radio">
            <input
              type="radio"
              name="format"
              value="zip"
              checked={format.value === "zip"}
              onChange={() => (format.value = "zip")}
            />
            <span>ZIP (mit Medien, DSGVO-konform)</span>
          </label>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Umfang</label>
        <div class="radio-group">
          <label class="radio">
            <input
              type="radio"
              name="scope"
              value="all"
              checked={scope.value === "all"}
              onChange={() => (scope.value = "all")}
            />
            <span>Alles</span>
          </label>
          <label class="radio">
            <input
              type="radio"
              name="scope"
              value="comments"
              checked={scope.value === "comments"}
              onChange={() => (scope.value = "comments")}
            />
            <span>Nur Comments</span>
          </label>
          <label class="radio">
            <input
              type="radio"
              name="scope"
              value="uploads"
              checked={scope.value === "uploads"}
              onChange={() => (scope.value = "uploads")}
            />
            <span>Nur Uploads</span>
          </label>
        </div>
      </div>

      <button class="btn primary full-width" onClick={doExport} disabled={exporting.value}>
        {exporting.value ? "Exportiere…" : "Export starten"}
      </button>

      {exportResult.value && (
        <div class={`export-result ${exportResult.value.success ? "success" : "error"}`}>
          {exportResult.value.success ? (
            <>
              Export abgeschlossen: {exportResult.value.filename}
              <button
                class="btn open-folder-btn"
                onClick={openFolder}
                disabled={openingFolder.value}
              >
                {openingFolder.value ? "Öffne…" : "Im Ordner öffnen"}
              </button>
            </>
          ) : (
            `Fehler: ${exportResult.value.error}`
          )}
        </div>
      )}
    </div>
  );
}
