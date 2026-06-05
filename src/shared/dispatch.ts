// pr0Vault — Message-Dispatch-Invariante
// Garantiert: sendResponse wird für jede Route genau einmal aufgerufen
// (Erfolg oder Fehler). Verhindert hängende MV3-Message-Channels.

import { logErr } from "./logger";
import type { VaultResponse } from "./messages";

export type ErrorResponse = { success: false; error: string };

// Achtung: matcht JEDE { success:false, error }-Form — sowohl die von
// respondAsync erzeugte Transport-Fehlerhülle als auch legitime fachliche
// Misserfolge (z. B. handleExport returnt success:false bewusst als Ergebnis).
// Daher NICHT auf den EXPORT-Pfad anwenden, wo success:false ein anzuzeigendes
// Resultat ist, kein Transportfehler.
export function isErrorResponse(r: unknown): r is ErrorResponse {
  return (
    !!r &&
    typeof r === "object" &&
    (r as { success?: unknown }).success === false &&
    typeof (r as { error?: unknown }).error === "string"
  );
}

export function respondAsync(
  route: () => Promise<VaultResponse>,
  msgType: string,
  sendResponse: (r: VaultResponse) => void
): true {
  let sent = false;
  const safeSend = (r: VaultResponse) => {
    if (sent) return;
    sent = true;
    try {
      sendResponse(r);
    } catch (e) {
      // Toter Channel (z. B. Popup geschlossen): nicht eskalieren, nur loggen.
      logErr("SW", `sendResponse failed [${msgType}]: ${String(e)}`);
    }
  };
  route()
    .then((res) => safeSend(res))
    .catch((e) => {
      logErr("SW", `Handler error [${msgType}]: ${String(e)}`);
      const err: ErrorResponse = { success: false, error: String(e) };
      safeSend(err);
    });
  return true; // Channel offen halten für async-Antwort
}
