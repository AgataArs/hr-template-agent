import { useState, useCallback, useRef } from "react";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { generateSampleDocs } from "./sampleDocs.js";

const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
const API_URL = "/api/anthropic";

// ─── ZIP parser — obsługuje store (0) i deflate (8) ──────────────────────────
async function parseDocxFiles(file) {
  const buffer = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });

  const bytes = new Uint8Array(buffer);
  const dec = new TextDecoder("utf-8");
  const files = {};
  let i = 0;

  // Dynamically import pako for deflate decompression
  let inflate;
  try {
    const pako = await import("https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.esm.mjs");
    inflate = pako.inflateRaw;
  } catch {
    inflate = null;
  }

  while (i < bytes.length - 4) {
    // Local file header signature: PK\x03\x04
    if (bytes[i] === 0x50 && bytes[i+1] === 0x4b && bytes[i+2] === 0x03 && bytes[i+3] === 0x04) {
      const compression = bytes[i+8]  | (bytes[i+9]  << 8);
      const compSize    = bytes[i+18] | (bytes[i+19] << 8) | (bytes[i+20] << 16) | (bytes[i+21] << 24);
      const uncompSize  = bytes[i+22] | (bytes[i+23] << 8) | (bytes[i+24] << 16) | (bytes[i+25] << 24);
      const nameLen     = bytes[i+26] | (bytes[i+27] << 8);
      const extraLen    = bytes[i+28] | (bytes[i+29] << 8);
      const nameStart   = i + 30;
      const name        = dec.decode(bytes.slice(nameStart, nameStart + nameLen));
      const dataStart   = nameStart + nameLen + extraLen;
      const compData    = bytes.slice(dataStart, dataStart + compSize);

      let fileData = null;
      if (compression === 0) {
        // STORE — no compression
        fileData = compData;
      } else if (compression === 8 && inflate) {
        // DEFLATE
        try { fileData = inflate(compData); } catch { fileData = compData; }
      } else {
        fileData = compData;
      }

      files[name] = fileData;
      i = dataStart + Math.max(compSize, 1);
    } else {
      i++;
    }
  }

  if (Object.keys(files).length === 0) {
    throw new Error(`Nie można odczytać pliku ${file.name} — upewnij się że to poprawny plik .docx`);
  }

  return files;
}

function xmlToText(xmlBytes) {
  const dec = new TextDecoder("utf-8");
  const xml = dec.decode(xmlBytes);
  const paragraphs = xml.split(/<w:p[ >\/]/);
  return paragraphs
    .map(para => [...para.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]).join(""))
    .filter(t => t.trim())
    .join("\n");
}

// ─── Tryb 1: Przepisanie danych do template'u (Claude AI) ────────────────────
async function extractTextFromDocx(file) {
  const files = await parseDocxFiles(file);
  const docXml = files["word/document.xml"];
  if (!docXml) throw new Error(`Brak word/document.xml w pliku ${file.name}`);
  const text = xmlToText(docXml);
  if (!text.trim()) throw new Error(`Nie udało się odczytać tekstu z ${file.name} — plik może być pusty lub zaszyfrowany`);
  return text;
}

async function mergeWithTemplate(templateText, targetText) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4000,
      messages: [{
        role: "user",
        content: `Jesteś precyzyjnym agentem HR do wypełniania dokumentów.\n\n## TEMPLATE (wzór - struktura MUSI być zachowana w 100%):\n${templateText}\n\n---\n\n## DOKUMENT ŹRÓDŁOWY (dane do przepisania):\n${targetText}\n\n---\n\nINSTRUKCJE:\n1. Zachowaj CAŁĄ strukturę, nagłówki i stały tekst z TEMPLATE\n2. Znajdź odpowiedniki pól między dokumentami i przepisz wartości\n3. Pola bez odpowiednika pozostaw jako puste miejsce lub oryginalny placeholder\n4. NIE dodawaj nowych sekcji, NIE usuwaj istniejących\n5. NIE dodawaj komentarzy ani wyjaśnień\n\nZwróć TYLKO wypełniony dokument zachowując strukturę template'u.`,
      }],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Błąd API: HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.content?.find(b => b.type === "text")?.text || "";
}

async function createDocxFromText(text) {
  const lines = text.split("\n");
  const children = lines.map(line => {
    const clean = line.replace(/^#+\s*/, "").replace(/\*\*/g, "").trim();
    if (!clean) return new Paragraph({ text: "" });
    const isHeading = line.startsWith("##") || line.startsWith("# ") ||
      (/^[A-ZŁÓŚĄĘŹŻĆŃ\s:\/\-]+$/.test(clean) && clean.length > 3 && clean.length < 80);
    if (isHeading) {
      return new Paragraph({
        children: [new TextRun({ text: clean, bold: true, color: "1F3A8C", size: 26 })],
        spacing: { before: 200, after: 60 },
      });
    }
    const colonIdx = clean.indexOf(":");
    if (colonIdx > 0 && colonIdx < clean.length - 1) {
      return new Paragraph({
        children: [
          new TextRun({ text: clean.substring(0, colonIdx + 1), bold: true, size: 22 }),
          new TextRun({ text: clean.substring(colonIdx + 1), size: 22 }),
        ],
        spacing: { before: 40, after: 40 },
      });
    }
    return new Paragraph({
      children: [new TextRun({ text: clean, size: 22 })],
      spacing: { before: 40, after: 40 },
    });
  });

  const doc = new Document({
    sections: [{
      properties: { page: { margin: { top: 1134, right: 1134, bottom: 1134, left: 1701 } } },
      children,
    }],
  });
  return await Packer.toBlob(doc);
}

// ─── Tryb 2: Wstaw treść do layoutu HR (backend JSZip) ───────────────────────
async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const bytes = new Uint8Array(e.target.result);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      resolve(btoa(binary));
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

async function injectContentIntoLayout(contentFile, layoutFile) {
  const [contentBase64, layoutBase64] = await Promise.all([
    fileToBase64(contentFile),
    fileToBase64(layoutFile),
  ]);

  const res = await fetch("/api/merge-layout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contentBase64, layoutBase64 }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Błąd serwera: HTTP ${res.status}`);
  }

  const { docxBase64 } = await res.json();
  if (!docxBase64) throw new Error("Serwer nie zwrócił pliku DOCX");

  const binary = atob(docxBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

// ─── UI Components ────────────────────────────────────────────────────────────
function ModeToggle({ mode, onChange }) {
  return (
    <div style={{ display: "flex", gap: 0, background: "#0f172a", borderRadius: 10, padding: 4, border: "1px solid #1e293b", marginBottom: 24 }}>
      {[
        { id: "merge", label: "🔀 Przepisz dane do template'u", desc: "Claude wypełnia wzór danymi" },
        { id: "layout", label: "🎨 Wstaw treść do layoutu HR", desc: "Zachowuje nagłówek, stopkę, logo" },
      ].map(m => (
        <button
          key={m.id}
          onClick={() => onChange(m.id)}
          style={{
            flex: 1, padding: "10px 16px", borderRadius: 8, border: "none",
            background: mode === m.id ? "linear-gradient(135deg,#6366f1,#8b5cf6)" : "transparent",
            color: mode === m.id ? "#fff" : "#475569",
            cursor: "pointer", transition: "all 0.2s", textAlign: "left",
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 13 }}>{m.label}</div>
          <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>{m.desc}</div>
        </button>
      ))}
    </div>
  );
}

function Dropzone({ label, tag, color, file, onFile, accept = ".docx" }) {
  const [over, setOver] = useState(false);
  const ref = useRef();
  return (
    <div
      onClick={() => ref.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
      style={{
        flex: 1, border: `2px dashed ${over ? color : file ? "#22c55e" : "#2d3748"}`,
        borderRadius: 12, padding: "24px 16px", cursor: "pointer",
        background: over ? `${color}11` : file ? "#22c55e11" : "#ffffff04",
        transition: "all 0.18s", textAlign: "center", minWidth: 0,
      }}
    >
      <input ref={ref} type="file" accept={accept} hidden onChange={(e) => e.target.files[0] && onFile(e.target.files[0])} />
      <div style={{ fontSize: 28, marginBottom: 8 }}>{file ? "✅" : tag === "WZÓR" || tag === "LAYOUT" ? "🗂️" : "📝"}</div>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: file ? "#22c55e" : color, fontFamily: "monospace", marginBottom: 4 }}>{tag}</div>
      <div style={{ fontSize: 12, fontWeight: 600, color: "#9ca3af" }}>{label}</div>
      {file
        ? <div style={{ marginTop: 6, fontSize: 11, color: "#22c55e", fontFamily: "monospace", wordBreak: "break-all" }}>{file.name}</div>
        : <div style={{ marginTop: 4, fontSize: 11, color: "#4b5563" }}>przeciągnij lub kliknij</div>}
    </div>
  );
}

function Step({ n, label, active, done }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{
        width: 26, height: 26, borderRadius: "50%",
        background: done ? "#22c55e" : active ? "#6366f1" : "#1f2937",
        color: done || active ? "#fff" : "#4b5563",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 12, fontWeight: 700, flexShrink: 0, transition: "all 0.3s",
      }}>{done ? "✓" : n}</div>
      <span style={{ fontSize: 12, color: done ? "#22c55e" : active ? "#a5b4fc" : "#4b5563" }}>{label}</span>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [mode, setMode] = useState("merge");

  // Merge mode state
  const [templateFile, setTemplateFile] = useState(null);
  const [targetFile, setTargetFile] = useState(null);

  // Layout mode state
  const [contentFile, setContentFile] = useState(null);
  const [layoutFile, setLayoutFile] = useState(null);

  const [logs, setLogs] = useState([]);
  const [running, setRunning] = useState(false);
  const [resultBlob, setResultBlob] = useState(null);
  const [resultName, setResultName] = useState("");
  const [preview, setPreview] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const logsEndRef = useRef();

  const log = useCallback((msg, type = "info") => {
    setLogs(prev => [...prev, { msg, type, t: new Date().toLocaleTimeString("pl-PL") }]);
    setTimeout(() => logsEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }, []);

  const reset = () => { setResultBlob(null); setLogs([]); setPreview(""); setShowPreview(false); };

  const handleModeChange = (m) => {
    setMode(m);
    reset();
  };

  const downloadSamples = () => {
    const { templateBlob, targetBlob } = generateSampleDocs();
    const a1 = document.createElement("a"); a1.href = URL.createObjectURL(templateBlob); a1.download = "template_wzor.docx"; a1.click();
    setTimeout(() => {
      const a2 = document.createElement("a"); a2.href = URL.createObjectURL(targetBlob); a2.download = "kandydat_jan_kowalski.docx"; a2.click();
    }, 500);
  };

  const runMerge = async () => {
    if (!templateFile || !targetFile) return;
    setRunning(true); reset();
    try {
      log("📂 Wczytuję i parsuję template...");
      const templateText = await extractTextFromDocx(templateFile);

      log("📂 Wczytuję i parsuję dokument kandydata...");
      const targetText = await extractTextFromDocx(targetFile);

      log("✍️  Claude przepisuje dane do template'u...");
      const merged = await mergeWithTemplate(templateText, targetText);
      if (!merged.trim()) throw new Error("Claude zwrócił pusty dokument — spróbuj ponownie");
      setPreview(merged);

      log("📦 Generuję plik DOCX...");
      const blob = await createDocxFromText(merged);
      const name = `wypelniony_${templateFile.name.replace(/\.docx$/i, "")}_${Date.now()}.docx`;
      setResultBlob(blob); setResultName(name);
      log("✅ Gotowe!", "success");
    } catch (err) {
      log(`❌ Błąd: ${err.message}`, "error");
    } finally {
      setRunning(false);
    }
  };

  const runLayout = async () => {
    if (!contentFile || !layoutFile) return;
    setRunning(true); reset();
    try {
      log("📂 Wczytuję plik z treścią...");
      log("🎨 Wczytuję layout HR...");

      const blob = await injectContentIntoLayout(contentFile, layoutFile);

      const name = `${contentFile.name.replace(/\.docx$/i, "")}_layout_HR.docx`;
      setResultBlob(blob); setResultName(name);
      log("✅ Gotowe! Treść wstawiona do layoutu HR.", "success");
    } catch (err) {
      log(`❌ Błąd: ${err.message}`, "error");
    } finally {
      setRunning(false);
    }
  };

  // Steps for each mode
  const isMerge = mode === "merge";
  const file1 = isMerge ? templateFile : contentFile;
  const file2 = isMerge ? targetFile : layoutFile;
  const canRun = file1 && file2 && !running;
  const activeStep = !file1 ? 1 : !file2 ? 2 : running ? 3 : resultBlob ? 4 : 3;

  const steps = isMerge
    ? ["Wgraj template (wzór)", "Wgraj dokument z danymi", "Uruchom agenta", "Pobierz wynik"]
    : ["Wgraj dokument z treścią", "Wgraj layout HR", "Połącz dokumenty", "Pobierz wynik"];

  return (
    <div style={{ minHeight: "100vh", background: "#070b14", color: "#e2e8f0", fontFamily: "'Segoe UI', system-ui, sans-serif" }}>
      <header style={{ borderBottom: "1px solid #0f172a", background: "#0a0f1e", padding: "0 32px", display: "flex", alignItems: "center", height: 60, gap: 12 }}>
        <div style={{ width: 36, height: 36, borderRadius: 8, background: "linear-gradient(135deg,#6366f1,#8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>📋</div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-0.3px" }}>HR Template Agent</div>
          <div style={{ fontSize: 11, color: "#475569" }}>Powered by Claude AI · Automatyzacja dokumentów HR</div>
        </div>
        <div style={{ flex: 1 }} />
        {isMerge && (
          <button onClick={downloadSamples} style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid #1e3a5f", background: "rgba(99,102,241,0.1)", color: "#818cf8", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
            ⬇️ Pobierz przykładowe dokumenty
          </button>
        )}
      </header>

      <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px 24px" }}>
        <ModeToggle mode={mode} onChange={handleModeChange} />

        <div style={{ display: "flex", gap: 28 }}>
          {/* Steps sidebar */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingTop: 4, minWidth: 190 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#334155", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>Kroki</div>
            {steps.map((label, idx) => (
              <Step key={idx} n={idx + 1} label={label} active={activeStep === idx + 1} done={
                idx === 0 ? !!file1 :
                idx === 1 ? !!file2 :
                idx === 2 ? !!resultBlob :
                false
              } />
            ))}

            <div style={{ marginTop: 16, padding: 12, background: "#0f172a", borderRadius: 8, border: "1px solid #1e293b" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#475569", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                {isMerge ? "Jak to działa" : "ℹ️ Ten tryb"}
              </div>
              <div style={{ fontSize: 11, color: "#64748b", lineHeight: 1.6 }}>
                {isMerge
                  ? "Claude czyta oba dokumenty, identyfikuje pola i przepisuje dane zachowując strukturę template'u."
                  : "Treść dokumentu zostaje wstawiona do layoutu HR — zachowany jest oryginalny nagłówek, stopka, logo i style strony."}
              </div>
            </div>
          </div>

          {/* Main content */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 20 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#475569", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12 }}>
                {isMerge ? "Dokumenty (.docx)" : "Pliki do połączenia (.docx)"}
              </div>
              <div style={{ display: "flex", gap: 14 }}>
                {isMerge ? (
                  <>
                    <Dropzone label="Template / Wzór" tag="WZÓR" color="#6366f1" file={templateFile} onFile={(f) => { setTemplateFile(f); reset(); }} />
                    <Dropzone label="Dokument z danymi" tag="DANE" color="#f59e0b" file={targetFile} onFile={(f) => { setTargetFile(f); reset(); }} />
                  </>
                ) : (
                  <>
                    <Dropzone label="Dokument z treścią" tag="TREŚĆ" color="#f59e0b" file={contentFile} onFile={(f) => { setContentFile(f); reset(); }} />
                    <Dropzone label="Layout HR (nagłówek/stopka)" tag="LAYOUT" color="#6366f1" file={layoutFile} onFile={(f) => { setLayoutFile(f); reset(); }} />
                  </>
                )}
              </div>
            </div>

            {/* Flow visualization */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 12, color: "#334155" }}>
              {isMerge ? (
                <>
                  <span style={{ padding: "3px 10px", background: "#0f172a", borderRadius: 20, color: "#818cf8" }}>🗂️ Template</span>
                  <span>+</span>
                  <span style={{ padding: "3px 10px", background: "#0f172a", borderRadius: 20, color: "#fbbf24" }}>📝 Dane</span>
                  <span>→</span>
                  <span style={{ color: "#6366f1", fontWeight: 600 }}>🤖 Claude</span>
                  <span>→</span>
                  <span style={{ padding: "3px 10px", background: "rgba(99,102,241,0.15)", borderRadius: 20, color: "#a5b4fc" }}>✅ Wypełniony dok.</span>
                </>
              ) : (
                <>
                  <span style={{ padding: "3px 10px", background: "#0f172a", borderRadius: 20, color: "#fbbf24" }}>📝 Treść</span>
                  <span>+</span>
                  <span style={{ padding: "3px 10px", background: "#0f172a", borderRadius: 20, color: "#818cf8" }}>🎨 Layout HR</span>
                  <span>→</span>
                  <span style={{ color: "#6366f1", fontWeight: 600 }}>⚙️ Merge XML</span>
                  <span>→</span>
                  <span style={{ padding: "3px 10px", background: "rgba(99,102,241,0.15)", borderRadius: 20, color: "#a5b4fc" }}>✅ Dok. w layoucie HR</span>
                </>
              )}
            </div>

            {/* Run button */}
            <button
              onClick={isMerge ? runMerge : runLayout}
              disabled={!canRun}
              style={{
                padding: "13px 20px", borderRadius: 10, border: "none",
                background: canRun ? "linear-gradient(135deg,#6366f1,#8b5cf6)" : "#0f172a",
                color: canRun ? "#fff" : "#334155",
                fontSize: 14, fontWeight: 700,
                cursor: canRun ? "pointer" : "not-allowed",
                transition: "all 0.2s",
              }}
            >
              {running
                ? (isMerge ? "⚙️ Claude pracuje..." : "⚙️ Łączę dokumenty...")
                : (isMerge ? "🚀 Uruchom Agenta" : "🎨 Połącz z layoutem HR")}
            </button>

            {/* Logs */}
            {logs.length > 0 && (
              <div style={{ background: "#060b14", border: "1px solid #0f172a", borderRadius: 10, padding: 14, fontFamily: "monospace", fontSize: 12, maxHeight: 200, overflowY: "auto" }}>
                {logs.map((l, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, marginBottom: 3, color: l.type === "error" ? "#f87171" : l.type === "success" ? "#4ade80" : "#94a3b8" }}>
                    <span style={{ color: "#1e293b", minWidth: 65 }}>{l.t}</span>
                    <span>{l.msg}</span>
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>
            )}

            {/* Result */}
            {resultBlob && (
              <div style={{ background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.25)", borderRadius: 10, padding: "16px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontWeight: 700, color: "#4ade80", fontSize: 14 }}>✅ Dokument gotowy</div>
                  <div style={{ fontSize: 11, color: "#475569", fontFamily: "monospace", marginTop: 2 }}>{resultName}</div>
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  {isMerge && (
                    <button onClick={() => setShowPreview(!showPreview)} style={{ padding: "7px 14px", borderRadius: 7, border: "1px solid #1e293b", background: "transparent", color: "#64748b", fontSize: 12, cursor: "pointer" }}>
                      {showPreview ? "Ukryj podgląd" : "Podgląd tekstu"}
                    </button>
                  )}
                  <a
                    href={URL.createObjectURL(resultBlob)}
                    download={resultName}
                    style={{ padding: "8px 20px", borderRadius: 8, background: "linear-gradient(135deg,#22c55e,#16a34a)", color: "#fff", fontSize: 13, fontWeight: 700, textDecoration: "none" }}
                  >
                    ⬇️ Pobierz DOCX
                  </a>
                </div>
              </div>
            )}

            {showPreview && preview && (
              <div style={{ background: "#0a0f1e", border: "1px solid #0f172a", borderRadius: 10, padding: 20, maxHeight: 380, overflowY: "auto", fontSize: 13, lineHeight: 1.75, whiteSpace: "pre-wrap", color: "#cbd5e1" }}>
                {preview}
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        *, *::before, *::after { box-sizing: border-box; }
        body { margin: 0; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #0a0f1e; }
        ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 3px; }
        button:hover:not(:disabled) { opacity: 0.9; }
      `}</style>
    </div>
  );
}
