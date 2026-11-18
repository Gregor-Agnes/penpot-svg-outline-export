// SVG-Export: Text als Pfade
// Arbeitsweise pro ausgewähltem Shape:
//   1. temporäre Kopie anlegen (Original bleibt unberührt)
//   2. Komponenten-Instanzen in der Kopie lösen (sonst lässt sich Text darin nicht flatten)
//   3. alle Texte in der Kopie per penpot.flatten() in Pfade umwandeln
//   4. Kopie als SVG exportieren und wieder löschen

const UI_URL = "https://gregor-agnes.github.io/penpot-svg-outline-export/ui.html";

penpot.ui.open("SVG-Export: Text als Pfade", `${UI_URL}?theme=${penpot.theme}`, {
  width: 340,
  height: 460,
});

function describeSelection() {
  return penpot.selection.map((s) => ({ id: s.id, name: s.name, type: s.type }));
}

function sendSelection() {
  penpot.ui.sendMessage({ type: "selection", items: describeSelection() });
}

function sendStatus(text, level = "info") {
  penpot.ui.sendMessage({ type: "status", text, level });
}

// Automatischer Export: Sobald sich die Auswahl ändert (und kurz ruhig bleibt),
// wird die Auswahl mit Text als Pfaden exportiert. Die Ergebnisse stehen dann im
// Fenster bereit, damit Speichern/Öffnen/Kopieren direkt per Klick möglich sind.
const DEBOUNCE_MS = 700;
let timer = null;
let busy = false;
let pending = false;
let rerunsLeft = 2;

function selectionKey() {
  return penpot.selection.map((s) => s.id).join(",");
}

let lastKey = "";

function onSelectionChange() {
  // Während des Exports entstehen temporäre Kopien; deren Ereignisse ignorieren.
  if (busy) return;
  sendSelection();
  const key = selectionKey();
  if (key === lastKey) return;
  lastKey = key;
  rerunsLeft = 2;
  scheduleExport();
}

function scheduleExport() {
  clearTimeout(timer);
  if (penpot.selection.length === 0) {
    penpot.ui.sendMessage({ type: "clear" });
    return;
  }
  penpot.ui.sendMessage({ type: "preparing" });
  timer = setTimeout(runExport, DEBOUNCE_MS);
}

penpot.on("selectionchange", onSelectionChange);
penpot.on("themechange", (theme) => penpot.ui.sendMessage({ type: "theme", theme }));

penpot.ui.onMessage(async (msg) => {
  try {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "ready") {
      sendSelection();
      lastKey = selectionKey();
      scheduleExport();
    }
  } catch (e) {
    reportError(e);
  }
});

function reportError(e) {
  const text = e && e.message ? e.message : String(e);
  try {
    sendStatus("Fehler: " + text, "error");
  } catch (_) {
    // Fenster nicht erreichbar
  }
}

// Bytes als Binär-String übertragen. Das ist robuster als Typed Arrays
// über die Grenze zwischen Plugin-Sandbox und Fenster.
function bytesToBinary(bytes) {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return out;
}

function collectTexts(root) {
  const texts = penpotUtils_findAll(root, (s) => s.type === "text");
  return texts;
}

// Eigene kleine Baumsuche, damit das Plugin ohne weitere Hilfsobjekte auskommt.
function penpotUtils_findAll(root, predicate) {
  const result = [];
  const walk = (shape) => {
    if (predicate(shape)) result.push(shape);
    const children = shape.children;
    if (Array.isArray(children)) children.forEach(walk);
  };
  walk(root);
  return result;
}

async function detachAll(root) {
  // Verschachtelte Instanzen brauchen mehrere Durchgänge.
  for (let pass = 0; pass < 8; pass++) {
    const heads = penpotUtils_findAll(
      root,
      (s) => typeof s.isComponentHead === "function" && s.isComponentHead()
    );
    if (heads.length === 0) return;
    let detached = 0;
    for (const head of heads) {
      try {
        head.detach();
        detached++;
      } catch (e) {
        // Shape lässt sich nicht lösen, im nächsten Durchgang erneut versuchen
      }
    }
    await penpot.waitForLayoutUpdate();
    if (detached === 0) return;
  }
}

async function exportOutlined(shape) {
  const temp = shape.clone();
  try {
    await penpot.waitForLayoutUpdate();
    await detachAll(temp);

    const texts = collectTexts(temp);
    if (texts.length > 0) {
      penpot.flatten(texts);
      await penpot.waitForLayoutUpdate();
    }
    const remaining = collectTexts(temp).length;
    const bytes = await temp.export({ type: "svg" });
    return { bytes, flattened: texts.length, remaining };
  } finally {
    try {
      temp.remove();
    } catch (e) {
      // Kopie konnte nicht entfernt werden; Name macht sie auffindbar
    }
  }
}

async function runExport() {
  if (busy) {
    pending = true;
    return;
  }
  const selection = penpot.selection.slice();
  if (selection.length === 0) return;
  const key = selectionKey();

  busy = true;
  const files = [];
  let flattenedTotal = 0;
  let remainingTotal = 0;
  let ok = false;

  try {
    for (let i = 0; i < selection.length; i++) {
      const shape = selection[i];
      sendStatus(`Bereite Export vor (${i + 1} von ${selection.length}): ${shape.name} …`);
      const res = await exportOutlined(shape);
      flattenedTotal += res.flattened;
      remainingTotal += res.remaining;
      files.push({ name: shape.name, data: bytesToBinary(res.bytes) });
    }
    // Gleichnamige Ebenen bekommen eindeutige Dateinamen: Name, Name (2), Name (3) …
    const seen = {};
    files.forEach((f) => {
      const n = (seen[f.name] = (seen[f.name] || 0) + 1);
      if (n > 1) f.name = `${f.name} (${n})`;
    });
    ok = true;
  } catch (e) {
    reportError(e);
  } finally {
    busy = false;
  }

  const changed = selectionKey() !== key;
  if (ok && !changed) {
    penpot.ui.sendMessage({
      type: "result",
      files,
      flattened: flattenedTotal,
      remaining: remainingTotal,
    });
  }

  // Auswahl wurde während des Exports geändert (oder ein Lauf wartete): neu starten,
  // aber höchstens ein paar Mal hintereinander, damit nichts endlos läuft.
  if ((changed || pending) && rerunsLeft > 0) {
    rerunsLeft--;
    pending = false;
    lastKey = selectionKey();
    sendSelection();
    scheduleExport();
  } else {
    pending = false;
  }
}
