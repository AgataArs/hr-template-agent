"use client";

import { useState, useCallback, useRef } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────
interface LogEntry {
  time: string;
  msg: string;
  type: "info" | "success" | "error" | "working";
}

interface ResultFile {
  url: string;
  name: string;
}

// ─── ZIP Creator (pure JS, no lib needed) ────────────────────────────────────
function strToUint8(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function crc32(data: Uint8Array): number {
  const table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    return t;
  })();
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function w16(buf: Uint8Array, o: number, v: number) {
  buf[o] = v & 0xff; buf[o + 1] = (v >> 8) & 0xff;
}
function w32(buf: Uint8Array, o: number, v: number) {
  buf[o] = v & 0xff; buf[o + 1] = (v >> 8) & 0xff;
  buf[o + 2] = (v >> 16) & 0xff; buf[o + 3] = (v >> 24) & 0xff;
}

function createZip(files: [string, string | Uint8Array][]): Uint8Array {
  const entries: { name: string; nb: Uint8Array; db: Uint8Array; crc: number; sz: number; offset: number }[] = [];
  let offset = 0;
  const localHeaders: Uint8Array[] = [];

  for (const [name, content] of files) {
    const nb = strToUint8(name);
    const db = typeof content === "string" ? strToUint8(content) : content;
    const crc = crc32(db);
    const sz = db.length;
    const lh = new Uint8Array(30 + nb.length);
    w32(lh, 0, 0x04034b50); w16(lh, 4, 20); w16(lh, 6, 0); w16(lh, 8, 0);
    w16(lh, 10, 0); w16(lh, 12, 0); w32(lh, 14, crc);
    w32(lh, 18, sz); w32(lh, 22, sz); w16(lh, 26, nb.length); w16(lh, 28, 0);
    lh.set(nb, 30);
    entries.push({ name, nb, db, crc, sz, offset });
    localHeaders.push(lh);
    offset += lh.length + sz;
  }

  const cdHeaders = entries.map(({ nb, crc, sz, offset }) => {
    const cd = new Uint8Array(46 + nb.length);
    w32(cd, 0, 0x02014b50); w16(cd, 4, 20); w16(cd, 6, 20); w16(cd, 8, 0);
    w16(cd, 10, 0); w16(cd, 12, 0); w16(cd, 14, 0); w32(cd, 16, crc);
    w32(cd, 20, sz); w32(cd, 24, sz); w16(cd, 28, nb.length);
    w16(cd, 30, 0); w16(cd, 32, 0); w16(cd, 34, 0); w16(cd, 36, 0);
    w32(cd, 38, 0); w32(cd, 42, offset); cd.set(nb, 46);
    return cd;
  });

  const cdSize = cdHeaders.reduce((s, h) => s + h.length, 0);
  const eocd = new Uint8Array(22);
  w32(eocd, 0, 0x06054b50); w16(eocd, 4, 0); w16(eocd, 6, 0);
  w16(eocd, 8, entries.length); w16(eocd, 10, entries.length);
  w32(eocd, 12, cdSize); w32(eocd, 16, offset); w16(eocd, 20, 0);

  const parts: Uint8Array[] = [];
  entries.forEach((e, i) => { parts.push(localHeaders[i]); parts.push(e.db); });
  cdHeaders.forEach(h => parts.push(h));
  parts.push(eocd);

  const total = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { result.set(p, pos); pos += p.length; }
  return result;
}

// ─── DOCX Generator from merged text ─────────────────────────────────────────
function generateDocx(mergedText: string): Uint8Array {
  const paragraphs = mergedText.split("\n");

  const paraXml = paragraphs.map(p => {
    const text = p
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const isBold = p.startsWith("##") || p.startsWith("**") || /^[A-ZŻŹĆĄŚĘŁÓŃ\s]{4,}$/.test(p.trim());
    const isHeading = p.startsWith("# ") || p.startsWith("## ");
    const cleanText = text.replace(/^#+\s*/, "").replace(/\*\*/g, "");

    if (!cleanText.trim()) return `<w:p><w:pPr><w:spacing w:after="80"/></w:pPr></w:p>`;

    if (isHeading) {
      const level = p.startsWith("## ") ? 2 : 1;
      return `<w:p>
        <w:pPr>
          <w:pStyle w:val="Heading${level}"/>
          <w:spacing w:before="240" w:after="120"/>
        </w:pPr>
        <w:r><w:rPr><w:b/><w:sz w:val="${level === 1 ? "32" : "28"}"/><w:color w:val="${level === 1 ? "1e3a5f" : "2c5282"}"/></w:rPr>
        <w:t xml:space="preserve">${cleanText.trim()}</w:t></w:r>
      </w:p>`;
    }

    if (p.includes(":") && !p.startsWith(" ") && p.split(":")[0].length < 30) {
      const [label, ...rest] = p.split(":");
      const value = rest.join(":").trim();
      return `<w:p>
        <w:pPr><w:spacing w:after="100"/></w:pPr>
        <w:r><w:rPr><w:b/><w:sz w:val="22"/></w:rPr><w:t xml:space="preserve">${label.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}:</w:t></w:r>
        <w:r><w:rPr><w:sz w:val="22"/></w:rPr><w:t xml:space="preserve"> ${value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</w:t></w:r>
      </w:p>`;
    }

    return `<w:p>
      <w:pPr><w:spacing w:after="100"/></w:pPr>
      <w:r><w:rPr><w:sz w:val="22"/>${isBold ? "<w:b/>" : ""}</w:rPr>
      <w:t xml:space="preserve">${cleanText.trim()}</w:t></w:r>
    </w:p>`;
  }).join("\n");

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
${paraXml}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="1e3a5f"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="200" w:after="100"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="2c5282"/></w:rPr>
  </w:style>
</w:styles>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

  const appRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  return createZip([
    ["[Content_Types].xml", contentTypesXml],
    ["_rels/.rels", appRelsXml],
    ["word/document.xml", documentXml],
    ["word/styles.xml", stylesXml],
    ["word/_rels/document.xml.rels", relsXml],
  ]);
}

// ─── FileDropzone Component ───────────────────────────────────────────────────
function FileDropzone({
  label, sublabel, icon, file, onFile, sampleUrl, sampleName
}: {
  label: string; sublabel: string; icon: string;
  file: File | null; onFile: (f: File) => void;
  sampleUrl?: string; sampleName?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f && f.name.endsWith(".docx")) onFile(f);
  }, [onFile]);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "8px" }}>
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        style={{
          border: `2px dashed ${dragging ? "#818cf8" : file ? "#34d399" : "#2d2d4e"}`,
          borderRadius: "14px",
          padding: "32px 20px",
          textAlign: "center",
          cursor: "pointer",
          background: dragging ? "rgba(129,140,248,0.06)" : file ? "rgba(52,211,153,0.05)" : "rgba(255,255,255,0.02)",
          transition: "all 0.2s ease",
        }}
      >
        <input ref={inputRef} type="file" accept=".docx" style={{ display: "none" }}
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        <div style={{ fontSize: "36px", marginBottom: "10px" }}>{icon}</div>
        <div style={{
          fontWeight: 700, fontSize: "13px",
          color: file ? "#34d399" : "#94a3b8",
          fontFamily: "'IBM Plex Mono', monospace",
          marginBottom: "4px"
        }}>
          {label}
        </div>
        <div style={{ fontSize: "11px", color: "#475569", marginBottom: file ? "8px" : "0" }}>{sublabel}</div>
        {file && (
          <div style={{
            display: "inline-flex", alignItems: "center", gap: "6px",
            background: "rgba(52,211,153,0.1)", border: "1px solid rgba(52,211,153,0.3)",
            borderRadius: "20px", padding: "3px 10px",
            fontSize: "11px", color: "#34d399",
            fontFamily: "'IBM Plex Mono', monospace",
            maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis"
          }}>
            ✓ {file.name}
          </div>
        )}
      </div>
      {sampleUrl && (
        <a href={sampleUrl} download={sampleName}
          onClick={(e) => e.stopPropagation()}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: "6px",
            padding: "7px 12px", borderRadius: "8px",
            border: "1px solid #1e2d45", background: "rgba(99,102,241,0.06)",
            color: "#818cf8", fontSize: "11px", textDecoration: "none",
            fontFamily: "'IBM Plex Mono', monospace",
            transition: "all 0.15s"
          }}>
          ⬇ Pobierz przykład
        </a>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function HRAgent() {
  const [templateFile, setTemplateFile] = useState<File | null>(null);
  const [targetFile, setTargetFile] = useState<File | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [result, setResult] = useState<ResultFile | null>(null);
  const [previewText, setPreviewText] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [running, setRunning] = useState(false);

  const addLog = (msg: string, type: LogEntry["type"] = "info") => {
    const time = new Date().toLocaleTimeString("pl-PL");
    setLog(prev => [...prev, { time, msg, type }]);
  };

  const reset = () => {
    setResult(null); setLog([]); setPreviewText(""); setShowPreview(false);
  };

  const fileToBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const ab = e.target!.result as ArrayBuffer;
        const b64 = btoa(new Uint8Array(ab).reduce((d, b) => d + String.fromCharCode(b), ""));
        resolve(b64);
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });

  const callClaude = async (messages: object[], systemPrompt?: string) => {
    const body: Record<string, unknown> = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages,
    };
    if (systemPrompt) body.system = systemPrompt;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || `API error ${res.status}`);
    }
    const data = await res.json();
    return data.content.find((b: { type: string }) => b.type === "text")?.text || "";
  };

  const handleRun = async () => {
    if (!templateFile || !targetFile || !apiKey.trim()) return;
    setRunning(true); reset();

    try {
      addLog("📄 Wczytuję pliki...", "working");
      const [tmplB64, tgtB64] = await Promise.all([
        fileToBase64(templateFile),
        fileToBase64(targetFile),
      ]);

      addLog("🔍 Claude analizuje template...", "working");
      const templateText = await callClaude([{
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              data: tmplB64,
            },
          },
          {
            type: "text",
            text: `Wyciągnij CAŁY tekst z tego dokumentu Word (template/wzoru).
Zachowaj strukturę: sekcje, nagłówki, pola do wypełnienia.
Zwróć TYLKO tekst dokumentu, bez żadnych komentarzy.`,
          },
        ],
      }]);

      addLog("🔍 Claude analizuje dokument docelowy...", "working");
      const targetText = await callClaude([{
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              data: tgtB64,
            },
          },
          {
            type: "text",
            text: `Wyciągnij CAŁY tekst z tego dokumentu Word.
Zachowaj wszystkie dane: imiona, daty, opisy, umiejętności, etc.
Zwróć TYLKO tekst dokumentu, bez żadnych komentarzy.`,
          },
        ],
      }]);

      addLog("✍️ Przepisuję dane do template'u...", "working");
      const mergedText = await callClaude(
        [{
          role: "user",
          content: `## TEMPLATE (wzór - zachowaj jego strukturę w 100%):
${templateText}

---

## DOKUMENT ŹRÓDŁOWY (dane do przepisania):
${targetText}

---

ZADANIE: Wypełnij template danymi z dokumentu źródłowego.
- Zachowaj CAŁĄ strukturę, nagłówki i etykiety pól z template'u
- Zastąp placeholders [w nawiasach] prawdziwymi danymi ze źródła
- Jeśli pole nie ma odpowiednika - zostaw placeholder lub wpisz "—"
- NIE dodawaj danych których nie ma w template
- Zwróć TYLKO wypełniony dokument (format markdown/tekst strukturalny)`,
        }],
        "Jesteś precyzyjnym agentem HR. Wypełniasz dokumenty zgodnie z wzorem."
      );

      setPreviewText(mergedText);

      addLog("📦 Generuję plik DOCX...", "working");
      const docxBytes = generateDocx(mergedText);
      const blob = new Blob([docxBytes.buffer as ArrayBuffer], {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      const url = URL.createObjectURL(blob);
      const name = `wypelniony_${templateFile.name.replace(".docx", "")}_${Date.now()}.docx`;
      setResult({ url, name });

      addLog(`✅ Gotowe! Plik "${name}" jest gotowy.`, "success");
    } catch (err: unknown) {
      addLog(`❌ Błąd: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setRunning(false);
    }
  };

  const logColors: Record<LogEntry["type"], string> = {
    info: "#94a3b8", success: "#34d399", error: "#f87171", working: "#818cf8"
  };

  const canRun = !!templateFile && !!targetFile && apiKey.trim().length > 10 && !running;

  return (
    <div style={{ minHeight: "100vh", background: "#080810", color: "#e2e8f0" }}>
      {/* Top bar */}
      <div style={{
        borderBottom: "1px solid #12122a",
        padding: "16px 32px",
        display: "flex", alignItems: "center", gap: "14px",
        background: "rgba(255,255,255,0.015)",
        backdropFilter: "blur(10px)",
        position: "sticky", top: 0, zIndex: 10,
      }}>
        <div style={{
          width: "38px", height: "38px", borderRadius: "10px",
          background: "linear-gradient(135deg, #4f46e5, #7c3aed)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: "20px", boxShadow: "0 4px 20px rgba(79,70,229,0.4)"
        }}>📋</div>
        <div>
          <div style={{ fontWeight: 700, fontSize: "15px", letterSpacing: "-0.4px" }}>
            HR Template Agent
          </div>
          <div style={{ fontSize: "11px", color: "#475569", fontFamily: "'IBM Plex Mono', monospace" }}>
            powered by Claude AI · przepisuje dane do wzoru template&apos;u
          </div>
        </div>
      </div>

      <div style={{ maxWidth: "860px", margin: "0 auto", padding: "40px 24px" }}>

        {/* How it works banner */}
        <div style={{
          background: "linear-gradient(135deg, rgba(79,70,229,0.08), rgba(124,58,237,0.08))",
          border: "1px solid rgba(79,70,229,0.2)",
          borderRadius: "14px", padding: "16px 20px",
          display: "flex", alignItems: "center", gap: "12px",
          marginBottom: "32px", flexWrap: "wrap"
        }}>
          {[
            { icon: "🗂️", text: "Wgraj template" },
            { icon: "→", text: "" },
            { icon: "📝", text: "Wgraj dokument" },
            { icon: "→", text: "" },
            { icon: "🤖", text: "Claude AI" },
            { icon: "→", text: "" },
            { icon: "✅", text: "Wypełniony dokument" },
          ].map((step, i) => (
            <div key={i} style={{
              display: "flex", alignItems: "center",
              color: step.icon === "→" ? "#374151" : "#94a3b8",
              fontSize: step.icon === "→" ? "18px" : "13px",
              fontFamily: step.icon === "→" ? undefined : "'IBM Plex Mono', monospace",
              gap: "6px"
            }}>
              {step.icon !== "→" && <span style={{ fontSize: "18px" }}>{step.icon}</span>}
              {step.icon === "→" ? "→" : step.text}
            </div>
          ))}
        </div>

        {/* API Key */}
        <div style={{ marginBottom: "28px" }}>
          <label style={{
            display: "block", fontSize: "10px", fontWeight: 600,
            color: "#475569", marginBottom: "8px",
            textTransform: "uppercase", letterSpacing: "0.1em",
            fontFamily: "'IBM Plex Mono', monospace"
          }}>
            ANTHROPIC API KEY
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-ant-api03-..."
            style={{
              width: "100%", background: "#0d0d1a",
              border: `1px solid ${apiKey.length > 10 ? "rgba(52,211,153,0.4)" : "#1a1a33"}`,
              borderRadius: "10px", padding: "12px 16px",
              color: "#e2e8f0", fontSize: "13px",
              fontFamily: "'IBM Plex Mono', monospace", outline: "none",
              transition: "border-color 0.2s"
            }}
          />
          <div style={{ fontSize: "10px", color: "#334155", marginTop: "6px", fontFamily: "'IBM Plex Mono', monospace" }}>
            Klucz nie jest zapisywany — używany tylko do wywołań API w tej sesji
          </div>
        </div>

        {/* File zones */}
        <div style={{ marginBottom: "28px" }}>
          <label style={{
            display: "block", fontSize: "10px", fontWeight: 600,
            color: "#475569", marginBottom: "12px",
            textTransform: "uppercase", letterSpacing: "0.1em",
            fontFamily: "'IBM Plex Mono', monospace"
          }}>
            DOKUMENTY (.docx)
          </label>
          <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
            <FileDropzone
              label="TEMPLATE (wzór)"
              sublabel="Dokument ze strukturą do wypełnienia"
              icon="🗂️"
              file={templateFile}
              onFile={(f) => { setTemplateFile(f); reset(); }}
              sampleUrl="/samples/template_cv.docx"
              sampleName="template_cv.docx"
            />
            <FileDropzone
              label="DOKUMENT DOCELOWY"
              sublabel="Dokument z danymi do przepisania"
              icon="📝"
              file={targetFile}
              onFile={(f) => { setTargetFile(f); reset(); }}
              sampleUrl="/samples/dokument_anna_kowalska.docx"
              sampleName="dokument_anna_kowalska.docx"
            />
          </div>
        </div>

        {/* Run button */}
        <button
          onClick={handleRun}
          disabled={!canRun}
          style={{
            width: "100%", padding: "15px",
            borderRadius: "12px", border: "none",
            background: canRun
              ? "linear-gradient(135deg, #4f46e5, #7c3aed)"
              : "#111120",
            color: canRun ? "#fff" : "#2d2d4e",
            fontSize: "14px", fontWeight: 700, cursor: canRun ? "pointer" : "not-allowed",
            letterSpacing: "-0.2px", transition: "all 0.2s",
            boxShadow: canRun ? "0 4px 20px rgba(79,70,229,0.35)" : "none",
            marginBottom: "24px"
          }}>
          {running ? (
            <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "10px" }}>
              <span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>⚙</span>
              Agent pracuje...
            </span>
          ) : "🚀 Uruchom Agenta"}
        </button>

        {/* Log output */}
        {log.length > 0 && (
          <div style={{
            background: "#05050f", border: "1px solid #12122a",
            borderRadius: "12px", padding: "16px 20px",
            marginBottom: "20px", fontFamily: "'IBM Plex Mono', monospace", fontSize: "12px"
          }}>
            <div style={{ fontSize: "10px", color: "#374151", marginBottom: "10px", letterSpacing: "0.1em" }}>
              AGENT LOG
            </div>
            {log.map((entry, i) => (
              <div key={i} style={{
                display: "flex", gap: "12px", marginBottom: "5px",
                color: logColors[entry.type]
              }}>
                <span style={{ color: "#1e293b", minWidth: "65px" }}>{entry.time}</span>
                <span>{entry.msg}</span>
              </div>
            ))}
          </div>
        )}

        {/* Result */}
        {result && (
          <div style={{
            background: "rgba(52,211,153,0.06)",
            border: "1px solid rgba(52,211,153,0.25)",
            borderRadius: "12px", padding: "20px 24px",
            display: "flex", alignItems: "center",
            justifyContent: "space-between", gap: "16px",
            flexWrap: "wrap", marginBottom: "16px"
          }}>
            <div>
              <div style={{ fontWeight: 700, color: "#34d399", marginBottom: "4px", fontSize: "15px" }}>
                ✅ Plik gotowy do pobrania
              </div>
              <div style={{
                fontSize: "11px", color: "#475569",
                fontFamily: "'IBM Plex Mono', monospace"
              }}>
                {result.name}
              </div>
            </div>
            <div style={{ display: "flex", gap: "10px" }}>
              <button
                onClick={() => setShowPreview(!showPreview)}
                style={{
                  padding: "9px 16px", borderRadius: "9px",
                  border: "1px solid #1a2f4a", background: "transparent",
                  color: "#64748b", fontSize: "12px", cursor: "pointer",
                  fontFamily: "'IBM Plex Mono', monospace"
                }}>
                {showPreview ? "Ukryj podgląd" : "Podgląd tekstu"}
              </button>
              <a
                href={result.url} download={result.name}
                style={{
                  padding: "9px 22px", borderRadius: "9px",
                  background: "linear-gradient(135deg, #059669, #10b981)",
                  color: "#fff", fontSize: "13px", fontWeight: 700,
                  textDecoration: "none", display: "inline-block",
                  boxShadow: "0 4px 15px rgba(16,185,129,0.3)"
                }}>
                ⬇ Pobierz .docx
              </a>
            </div>
          </div>
        )}

        {/* Preview */}
        {showPreview && previewText && (
          <div style={{
            background: "#0a0a18", border: "1px solid #12122a",
            borderRadius: "12px", padding: "20px 24px",
            maxHeight: "500px", overflowY: "auto",
            fontSize: "13px", lineHeight: "1.75",
            whiteSpace: "pre-wrap", color: "#cbd5e1",
            fontFamily: "'IBM Plex Sans', sans-serif"
          }}>
            {previewText}
          </div>
        )}

        {/* Footer */}
        <div style={{
          marginTop: "48px", paddingTop: "24px",
          borderTop: "1px solid #0d0d20",
          textAlign: "center", fontSize: "11px",
          color: "#1e293b", fontFamily: "'IBM Plex Mono', monospace"
        }}>
          HR Template Agent · Claude AI · dane nie są przechowywane na serwerze
        </div>
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        input:focus { border-color: rgba(79,70,229,0.5) !important; box-shadow: 0 0 0 3px rgba(79,70,229,0.1); }
        button:hover:not(:disabled) { opacity: 0.9; transform: translateY(-1px); }
        a:hover { opacity: 0.9; }
      `}</style>
    </div>
  );
}
