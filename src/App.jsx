import { useState, useCallback, useRef } from "react";
import { generateSampleDocs } from "./sampleDocs.js";

const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
const API_URL = "/api/anthropic";

// ─── DOCX text extractor via Claude API ──────────────────────────────────────
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

async function extractTextFromDocx(base64, filename) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4000,
      messages: [{
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              data: base64,
            },
          },
          {
            type: "text",
            text: `Wyciągnij CAŁĄ treść tekstową z tego dokumentu Word: "${filename}".\nZwróć TYLKO surowy tekst, zachowując strukturę akapitów (nowe linie).\nUwzględnij WSZYSTKO: nagłówki, etykiety pól, wartości, placeholdery.\nNIE streszczaj — wyciągaj dosłownie.`,
          },
        ],
      }],
    }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.content.find((b) => b.type === "text")?.text || "";
}

async function mergeWithTemplate(templateText, targetText) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
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
    const err = await res.json();
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.content.find((b) => b.type === "text")?.text || "";
}

// ─── Minimal DOCX generator ───────────────────────────────────────────────────
function textToDocx(text) {
  const lines = text.split("\n");
  const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

  const paraXml = lines.map((line) => {
    const escaped = line
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

    const isBold = line.startsWith("##") || line.startsWith("**") ||
      /^[A-ZŁÓŚĄĘŹŻĆŃ\s:]+$/.test(line.trim()) && line.trim().length > 3;

    if (!line.trim()) return `<w:p><w:r><w:t></w:t></w:r></w:p>`;

    const clean = escaped.replace(/^#+\s*/, "").replace(/\*\*/g, "");

    if (isBold) {
      return `<w:p>
        <w:pPr><w:spacing w:before="200" w:after="60"/></w:pPr>
        <w:r><w:rPr><w:b/><w:color w:val="1F3A8C"/><w:sz w:val="26"/></w:rPr>
        <w:t xml:space="preserve">${clean}</w:t></w:r></w:p>`;
    }
    return `<w:p>
      <w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr>
      <w:r><w:rPr><w:sz w:val="22"/></w:rPr>
      <w:t xml:space="preserve">${clean}</w:t></w:r></w:p>`;
  }).join("\n");

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${ns}
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
${paraXml}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1701"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${ns}>
  <w:docDefaults>
    <w:rPrDefault><w:rPr>
      <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
      <w:sz w:val="22"/>
    </w:rPr></w:rPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
</w:styles>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

  const appRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const wordRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  return { documentXml, stylesXml, contentTypes, appRels, wordRels };
}

// ─── Pure JS ZIP builder ──────────────────────────────────────────────────────
function buildZip(files) {
  const enc = new TextEncoder();
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();

  function crc32(data) {
    let crc = 0xffffffff;
    for (const b of data) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function u16(v) { return [v & 0xff, (v >> 8) & 0xff]; }
  function u32(v) { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]; }

  const localEntries = [];
  const centralEntries = [];
  let offset = 0;

  for (const [name, content] of files) {
    const nameBytes = enc.encode(name);
    const data = typeof content === "string" ? enc.encode(content) : content;
    const crc = crc32(data);

    const local = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04,
      ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0),
      ...nameBytes,
    ]);

    localEntries.push({ local, data });

    const central = new Uint8Array([
      0x50, 0x4b, 0x01, 0x02,
      ...u16(20), ...u16(20),
      ...u16(0), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
      ...nameBytes,
    ]);
    centralEntries.push(central);
    offset += local.length + data.length;
  }

  const cdSize = centralEntries.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array([
    0x50, 0x4b, 0x05, 0x06,
    ...u16(0), ...u16(0),
    ...u16(localEntries.length), ...u16(localEntries.length),
    ...u32(cdSize), ...u32(offset), ...u16(0),
  ]);

  const parts = [];
  localEntries.forEach(({ local, data }) => { parts.push(local); parts.push(data); });
  centralEntries.forEach((c) => parts.push(c));
  parts.push(eocd);

  const total = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { result.set(p, pos); pos += p.length; }
  return result;
}

function createDocxBlob(mergedText) {
  const { documentXml, stylesXml, contentTypes, appRels, wordRels } = textToDocx(mergedText);
  const zip = buildZip([
    ["[Content_Types].xml", contentTypes],
    ["_rels/.rels", appRels],
    ["word/document.xml", documentXml],
    ["word/styles.xml", stylesXml],
    ["word/_rels/document.xml.rels", wordRels],
  ]);
  return new Blob([zip], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

// ─── Dropzone ─────────────────────────────────────────────────────────────────
function Dropzone({ label, tag, color, file, onFile }) {
  const [over, setOver] = useState(false);
  const ref = useRef();

  return (
    <div
      onClick={() => ref.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
      style={{
        flex: 1,
        border: `2px dashed ${over ? color : file ? "#22c55e" : "#2d3748"}`,
        borderRadius: 12,
        padding: "24px 16px",
        cursor: "pointer",
        background: over ? `${color}11` : file ? "#22c55e11" : "#ffffff04",
        transition: "all 0.18s",
        textAlign: "center",
        minWidth: 0,
      }}
    >
      <input ref={ref} type="file" accept=".docx" hidden onChange={(e) => e.target.files[0] && onFile(e.target.files[0])} />
      <div style={{ fontSize: 28, marginBottom: 8 }}>{file ? "✅" : tag === "WZÓR" ? "🗂️" : "📝"}</div>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: file ? "#22c55e" : color, fontFamily: "monospace", marginBottom: 4 }}>{tag}</div>
      <div style={{ fontSize: 12, fontWeight: 600, color: "#9ca3af" }}>{label}</div>
      {file
        ? <div style={{ marginTop: 6, fontSize: 11, color: "#22c55e", fontFamily: "monospace", wordBreak: "break-all" }}>{file.name}</div>
        : <div style={{ marginTop: 4, fontSize: 11, color: "#4b5563" }}>przeciągnij lub kliknij</div>}
    </div>
  );
}

// ─── Step indicator ───────────────────────────────────────────────────────────
function Step({ n, label, active, done }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{
        width: 26, height: 26, borderRadius: "50%",
        background: done ? "#22c55e" : active ? "#6366f1" : "#1f2937",
        color: done || active ? "#fff" : "#4b5563",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 12, fontWeight: 700, flexShrink: 0,
        transition: "all 0.3s",
      }}>{done ? "✓" : n}</div>
      <span style={{ fontSize: 12, color: done ? "#22c55e" : active ? "#a5b4fc" : "#4b5563" }}>{label}</span>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [templateFile, setTemplateFile] = useState(null);
  const [targetFile, setTargetFile] = useState(null);
  const [logs, setLogs] = useState([]);
  const [running, setRunning] = useState(false);
  const [resultBlob, setResultBlob] = useState(null);
  const [resultName, setResultName] = useState("");
  const [preview, setPreview] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const logsEndRef = useRef();

  const log = useCallback((msg, type = "info") => {
    setLogs((prev) => [...prev, { msg, type, t: new Date().toLocaleTimeString("pl-PL") }]);
    setTimeout(() => logsEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }, []);

  const reset = () => { setResultBlob(null); setLogs([]); setPreview(""); setShowPreview(false); };

  const downloadSamples = () => {
    const { templateBlob, targetBlob } = generateSampleDocs();
    const a1 = document.createElement("a"); a1.href = URL.createObjectURL(templateBlob); a1.download = "template_wzor.docx"; a1.click();
    setTimeout(() => {
      const a2 = document.createElement("a"); a2.href = URL.createObjectURL(targetBlob); a2.download = "kandydat_jan_kowalski.docx"; a2.click();
    }, 500);
  };

  const run = async () => {
    if (!templateFile || !targetFile) return;
    setRunning(true); reset();

    try {
      log("📂 Wczytuję template...");
      const templateB64 = await fileToBase64(templateFile);

      log("📂 Wczytuję dokument kandydata...");
      const targetB64 = await fileToBase64(targetFile);

      log("🔍 Claude analizuje template...");
      const templateText = await extractTextFromDocx(templateB64, templateFile.name);

      log("🔍 Claude analizuje dokument kandydata...");
      const targetText = await extractTextFromDocx(targetB64, targetFile.name);

      log("✍️  Claude przepisuje dane do template'u...");
      const merged = await mergeWithTemplate(templateText, targetText);
      setPreview(merged);

      log("📦 Generuję plik DOCX...");
      const blob = createDocxBlob(merged);
      const name = `wypelniony_${templateFile.name.replace(/\.docx$/i, "")}_${Date.now()}.docx`;
      setResultBlob(blob); setResultName(name);

      log("✅ Gotowe! Plik jest gotowy do pobrania.", "success");
    } catch (err) {
      log(`❌ Błąd: ${err.message}`, "error");
    } finally {
      setRunning(false);
    }
  };

  const step1Done = !!templateFile;
  const step2Done = !!targetFile;
  const canRun = step1Done && step2Done && !running;
  const activeStep = !step1Done ? 1 : !step2Done ? 2 : running ? 3 : resultBlob ? 4 : 3;

  return (
    <div style={{ minHeight: "100vh", background: "#070b14", color: "#e2e8f0", fontFamily: "'Segoe UI', system-ui, sans-serif" }}>
      {/* Header */}
      <header style={{ borderBottom: "1px solid #0f172a", background: "#0a0f1e", padding: "0 32px", display: "flex", alignItems: "center", height: 60, gap: 12 }}>
        <div style={{ width: 36, height: 36, borderRadius: 8, background: "linear-gradient(135deg,#6366f1,#8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>📋</div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-0.3px" }}>HR Template Agent</div>
          <div style={{ fontSize: 11, color: "#475569" }}>Powered by Claude AI · Przepisuje dane do wzorów dokumentów</div>
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={downloadSamples} style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid #1e3a5f", background: "rgba(99,102,241,0.1)", color: "#818cf8", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
          ⬇️ Pobierz przykładowe dokumenty
        </button>
      </header>

      <div style={{ maxWidth: 860, margin: "0 auto", padding: "32px 24px" }}>
        <div style={{ display: "flex", gap: 28 }}>
          {/* Steps */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingTop: 4, minWidth: 180 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#334155", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>Kroki</div>
            <Step n={1} label="Wgraj template" active={activeStep === 1} done={step1Done} />
            <Step n={2} label="Wgraj dokument" active={activeStep === 2} done={step2Done} />
            <Step n={3} label="Uruchom agenta" active={activeStep === 3} done={!!resultBlob} />
            <Step n={4} label="Pobierz wynik" active={activeStep === 4} done={false} />

            <div style={{ marginTop: 16, padding: "12px", background: "#0f172a", borderRadius: 8, border: "1px solid #1e293b" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#475569", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.08em" }}>Jak to działa</div>
              <div style={{ fontSize: 11, color: "#64748b", lineHeight: 1.6 }}>
                Claude czyta oba dokumenty, identyfikuje pola i przepisuje dane zachowując strukturę template'u.
              </div>
            </div>
          </div>

          {/* Main content */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 20 }}>
            {/* Dropzones */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#475569", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12 }}>Dokumenty (.docx)</div>
              <div style={{ display: "flex", gap: 14 }}>
                <Dropzone label="Template / Wzór" tag="WZÓR" color="#6366f1" file={templateFile} onFile={(f) => { setTemplateFile(f); reset(); }} />
                <Dropzone label="Dokument z danymi" tag="DANE" color="#f59e0b" file={targetFile} onFile={(f) => { setTargetFile(f); reset(); }} />
              </div>
            </div>

            {/* Flow arrow */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 12, color: "#334155" }}>
              <span style={{ padding: "3px 10px", background: "#0f172a", borderRadius: 20, color: "#818cf8" }}>🗂️ Template</span>
              <span style={{ color: "#1e293b" }}>+</span>
              <span style={{ padding: "3px 10px", background: "#0f172a", borderRadius: 20, color: "#fbbf24" }}>📝 Dane</span>
              <span>→</span>
              <span style={{ color: "#6366f1", fontWeight: 600 }}>🤖 Claude</span>
              <span>→</span>
              <span style={{ padding: "3px 10px", background: "rgba(99,102,241,0.15)", borderRadius: 20, color: "#a5b4fc" }}>✅ Gotowy dok.</span>
            </div>

            {/* Run button */}
            <button
              onClick={run}
              disabled={!canRun}
              style={{
                padding: "13px 20px",
                borderRadius: 10,
                border: "none",
                background: canRun ? "linear-gradient(135deg,#6366f1,#8b5cf6)" : "#0f172a",
                color: canRun ? "#fff" : "#334155",
                fontSize: 14,
                fontWeight: 700,
                cursor: canRun ? "pointer" : "not-allowed",
                letterSpacing: "-0.2px",
                transition: "all 0.2s",
              }}
            >
              {running ? "⚙️ Agent pracuje..." : "🚀 Uruchom Agenta"}
            </button>

            {/* Log output */}
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
                  <button onClick={() => setShowPreview(!showPreview)} style={{ padding: "7px 14px", borderRadius: 7, border: "1px solid #1e293b", background: "transparent", color: "#64748b", fontSize: 12, cursor: "pointer" }}>
                    {showPreview ? "Ukryj podgląd" : "Podgląd tekstu"}
                  </button>
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

            {/* Preview */}
            {showPreview && preview && (
              <div style={{ background: "#0a0f1e", border: "1px solid #0f172a", borderRadius: 10, padding: 20, maxHeight: 380, overflowY: "auto", fontSize: 13, lineHeight: 1.75, whiteSpace: "pre-wrap", color: "#cbd5e1" }}>
                {preview}
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes spin { from{transform:rotate(0)} to{transform:rotate(360deg)} }
        input:focus { border-color: #6366f1 !important; }
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
