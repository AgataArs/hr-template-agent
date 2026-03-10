// Generates two sample DOCX files for testing:
// 1. Template - HR onboarding form (structure/wzor)
// 2. Target - candidate CV / profile document

function enc(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildDocx(sections) {
  // sections: array of { type: "heading"|"subheading"|"field"|"value"|"empty", text }
  const paras = sections.map((s) => {
    const t = enc(s.text || "");
    switch (s.type) {
      case "title":
        return `<w:p>
          <w:pPr>
            <w:jc w:val="center"/>
            <w:spacing w:before="0" w:after="200"/>
          </w:pPr>
          <w:r><w:rPr>
            <w:b/><w:color w:val="1E3A5F"/>
            <w:sz w:val="36"/><w:szCs w:val="36"/>
            <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
          </w:rPr><w:t>${t}</w:t></w:r>
        </w:p>`;
      case "heading":
        return `<w:p>
          <w:pPr>
            <w:spacing w:before="280" w:after="80"/>
            <w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="6366F1"/></w:pBdr>
          </w:pPr>
          <w:r><w:rPr>
            <w:b/><w:color w:val="6366F1"/>
            <w:sz w:val="26"/><w:szCs w:val="26"/>
            <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
          </w:rPr><w:t>${t}</w:t></w:r>
        </w:p>`;
      case "field":
        return `<w:p>
          <w:pPr><w:spacing w:before="120" w:after="40"/></w:pPr>
          <w:r><w:rPr>
            <w:b/><w:color w:val="374151"/>
            <w:sz w:val="22"/>
            <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
          </w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>
        </w:p>`;
      case "value":
        return `<w:p>
          <w:pPr>
            <w:ind w:left="360"/>
            <w:spacing w:before="20" w:after="60"/>
          </w:pPr>
          <w:r><w:rPr>
            <w:color w:val="1F2937"/>
            <w:sz w:val="22"/>
            <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
          </w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>
        </w:p>`;
      case "placeholder":
        return `<w:p>
          <w:pPr>
            <w:ind w:left="360"/>
            <w:spacing w:before="20" w:after="60"/>
          </w:pPr>
          <w:r><w:rPr>
            <w:color w:val="9CA3AF"/>
            <w:i/>
            <w:sz w:val="22"/>
            <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
          </w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>
        </w:p>`;
      case "empty":
      default:
        return `<w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr><w:r><w:t></w:t></w:r></w:p>`;
    }
  });

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
${paras.join("\n")}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1701"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr>
    <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
    <w:sz w:val="22"/>
  </w:rPr></w:rPrDefault></w:docDefaults>
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

// ─── Pure JS ZIP builder (same as App.jsx) ────────────────────────────────────
function buildZip(files) {
  const encUtf8 = new TextEncoder();
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

  const localEntries = [], centralEntries = [];
  let offset = 0;

  for (const [name, content] of files) {
    const nameBytes = encUtf8.encode(name);
    const data = typeof content === "string" ? encUtf8.encode(content) : content;
    const crc = crc32(data);
    const local = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0), ...nameBytes,
    ]);
    localEntries.push({ local, data });
    const central = new Uint8Array([
      0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset), ...nameBytes,
    ]);
    centralEntries.push(central);
    offset += local.length + data.length;
  }

  const cdSize = centralEntries.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array([
    0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0),
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

function makeBlob(sections) {
  const { documentXml, stylesXml, contentTypes, appRels, wordRels } = buildDocx(sections);
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

// ─── Template document (HR Onboarding Form) ───────────────────────────────────
export function generateSampleDocs() {
  const templateSections = [
    { type: "title", text: "FORMULARZ WDROŻENIA PRACOWNIKA" },
    { type: "empty" },

    { type: "heading", text: "1. DANE OSOBOWE" },
    { type: "field", text: "Imię i nazwisko:" },
    { type: "placeholder", text: "[wpisz imię i nazwisko]" },
    { type: "field", text: "Data urodzenia:" },
    { type: "placeholder", text: "[DD.MM.RRRR]" },
    { type: "field", text: "Adres zamieszkania:" },
    { type: "placeholder", text: "[ulica, numer, kod pocztowy, miasto]" },
    { type: "field", text: "Numer telefonu:" },
    { type: "placeholder", text: "[+48 XXX XXX XXX]" },
    { type: "field", text: "Adres e-mail:" },
    { type: "placeholder", text: "[adres@email.pl]" },
    { type: "empty" },

    { type: "heading", text: "2. STANOWISKO I DZIAŁ" },
    { type: "field", text: "Stanowisko:" },
    { type: "placeholder", text: "[nazwa stanowiska]" },
    { type: "field", text: "Dział:" },
    { type: "placeholder", text: "[nazwa działu]" },
    { type: "field", text: "Bezpośredni przełożony:" },
    { type: "placeholder", text: "[imię i nazwisko przełożonego]" },
    { type: "field", text: "Data rozpoczęcia pracy:" },
    { type: "placeholder", text: "[DD.MM.RRRR]" },
    { type: "field", text: "Forma zatrudnienia:" },
    { type: "placeholder", text: "[umowa o pracę / B2B / zlecenie]" },
    { type: "empty" },

    { type: "heading", text: "3. WYKSZTAŁCENIE" },
    { type: "field", text: "Najwyższy poziom wykształcenia:" },
    { type: "placeholder", text: "[podstawowe / średnie / wyższe licencjackie / wyższe magisterskie / doktorat]" },
    { type: "field", text: "Kierunek studiów / specjalizacja:" },
    { type: "placeholder", text: "[kierunek]" },
    { type: "field", text: "Uczelnia / szkoła:" },
    { type: "placeholder", text: "[nazwa uczelni]" },
    { type: "field", text: "Rok ukończenia:" },
    { type: "placeholder", text: "[rok]" },
    { type: "empty" },

    { type: "heading", text: "4. DOŚWIADCZENIE ZAWODOWE" },
    { type: "field", text: "Lata doświadczenia w branży:" },
    { type: "placeholder", text: "[liczba lat]" },
    { type: "field", text: "Poprzedni pracodawca:" },
    { type: "placeholder", text: "[nazwa firmy]" },
    { type: "field", text: "Ostatnio zajmowane stanowisko:" },
    { type: "placeholder", text: "[stanowisko]" },
    { type: "field", text: "Kluczowe umiejętności:" },
    { type: "placeholder", text: "[lista umiejętności]" },
    { type: "empty" },

    { type: "heading", text: "5. JĘZYKI OBCE" },
    { type: "field", text: "Język 1:" },
    { type: "placeholder", text: "[język] – poziom: [A1/A2/B1/B2/C1/C2/native]" },
    { type: "field", text: "Język 2:" },
    { type: "placeholder", text: "[język] – poziom: [A1/A2/B1/B2/C1/C2]" },
    { type: "empty" },

    { type: "heading", text: "6. DANE DO LISTY PŁAC" },
    { type: "field", text: "Numer PESEL:" },
    { type: "placeholder", text: "[XXXXXXXXXXX]" },
    { type: "field", text: "Numer konta bankowego (IBAN):" },
    { type: "placeholder", text: "[PL XX XXXX XXXX XXXX XXXX XXXX XXXX]" },
    { type: "field", text: "Urząd skarbowy:" },
    { type: "placeholder", text: "[nazwa urzędu skarbowego]" },
    { type: "empty" },

    { type: "heading", text: "7. KONTAKT ALARMOWY" },
    { type: "field", text: "Imię i nazwisko osoby do kontaktu:" },
    { type: "placeholder", text: "[imię i nazwisko]" },
    { type: "field", text: "Relacja:" },
    { type: "placeholder", text: "[małżonek/rodzic/inne]" },
    { type: "field", text: "Telefon kontaktowy:" },
    { type: "placeholder", text: "[+48 XXX XXX XXX]" },
    { type: "empty" },

    { type: "field", text: "Data wypełnienia formularza:" },
    { type: "placeholder", text: "[DD.MM.RRRR]" },
    { type: "field", text: "Podpis pracownika:" },
    { type: "placeholder", text: "[podpis]" },
  ];

  // ─── Candidate document (CV-style, different structure) ──────────────────
  const targetSections = [
    { type: "title", text: "CURRICULUM VITAE" },
    { type: "empty" },

    { type: "heading", text: "INFORMACJE OSOBISTE" },
    { type: "field", text: "Imię:" },
    { type: "value", text: "Jan" },
    { type: "field", text: "Nazwisko:" },
    { type: "value", text: "Kowalski" },
    { type: "field", text: "Data urodzenia:" },
    { type: "value", text: "15.03.1992" },
    { type: "field", text: "Telefon:" },
    { type: "value", text: "+48 512 345 678" },
    { type: "field", text: "Email:" },
    { type: "value", text: "jan.kowalski@email.pl" },
    { type: "field", text: "Adres:" },
    { type: "value", text: "ul. Kwiatowa 12/4, 00-001 Warszawa" },
    { type: "empty" },

    { type: "heading", text: "WYKSZTAŁCENIE" },
    { type: "value", text: "2016 – Magister Inżynierii Oprogramowania" },
    { type: "value", text: "Politechnika Warszawska, Wydział Elektroniki i Technik Informacyjnych" },
    { type: "empty" },

    { type: "heading", text: "DOŚWIADCZENIE ZAWODOWE" },
    { type: "value", text: "2019 – 2024 | Senior Software Engineer | TechCorp Sp. z o.o." },
    { type: "value", text: "2016 – 2019 | Junior Developer | StartupXYZ" },
    { type: "empty" },

    { type: "heading", text: "UMIEJĘTNOŚCI" },
    { type: "value", text: "JavaScript, TypeScript, React, Node.js, Python, SQL, Docker, Git" },
    { type: "value", text: "Architektura mikroserwisów, REST API, Agile/Scrum" },
    { type: "empty" },

    { type: "heading", text: "JĘZYKI" },
    { type: "value", text: "Angielski – C1 (biegły)" },
    { type: "value", text: "Niemiecki – B1 (komunikatywny)" },
    { type: "empty" },

    { type: "heading", text: "DANE DODATKOWE" },
    { type: "field", text: "PESEL:" },
    { type: "value", text: "92031512345" },
    { type: "field", text: "Konto bankowe:" },
    { type: "value", text: "PL61 1090 1014 0000 0712 1981 2874" },
    { type: "field", text: "Urząd Skarbowy:" },
    { type: "value", text: "Urząd Skarbowy Warszawa-Mokotów" },
    { type: "empty" },

    { type: "heading", text: "KONTAKT AWARYJNY" },
    { type: "value", text: "Anna Kowalska (żona) – tel. +48 601 987 654" },
  ];

  return {
    templateBlob: makeBlob(templateSections),
    targetBlob: makeBlob(targetSections),
  };
}
