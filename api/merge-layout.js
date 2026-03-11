import JSZip from 'jszip';

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const { contentBase64, layoutBase64 } = req.body;
    if (!contentBase64 || !layoutBase64) {
      return res.status(400).json({ error: 'Brak contentBase64 lub layoutBase64' });
    }

    // Decode base64 to buffers
    const contentBuf = Buffer.from(contentBase64, 'base64');
    const layoutBuf  = Buffer.from(layoutBase64,  'base64');

    // Load both ZIPs
    const contentZip = await JSZip.loadAsync(contentBuf);
    const layoutZip  = await JSZip.loadAsync(layoutBuf);

    // Extract body content from content docx
    const contentDocFile = contentZip.file('word/document.xml');
    if (!contentDocFile) return res.status(400).json({ error: 'Brak word/document.xml w dokumencie treści' });
    const contentXml = await contentDocFile.async('string');

    // Extract body between <w:body> and last <w:sectPr>
    const bodyMatch = contentXml.match(/<w:body>([\s\S]*?)<w:sectPr[\s>]/);
    if (!bodyMatch) return res.status(400).json({ error: 'Nie znaleziono treści w dokumencie' });
    const bodyContent = bodyMatch[1];

    // Get layout document.xml
    const layoutDocFile = layoutZip.file('word/document.xml');
    if (!layoutDocFile) return res.status(400).json({ error: 'Brak word/document.xml w layoucie' });
    const layoutXml = await layoutDocFile.async('string');

    // Inject body before last <w:sectPr (which has header/footer refs)
    const sectPrIdx = layoutXml.lastIndexOf('<w:sectPr');
    if (sectPrIdx === -1) return res.status(400).json({ error: 'Brak sectPr w layoucie' });

    const mergedXml =
      layoutXml.substring(0, sectPrIdx) +
      bodyContent +
      layoutXml.substring(sectPrIdx);

    // Build output ZIP: all layout files + replaced document.xml
    const outputZip = new JSZip();
    const copyPromises = [];
    layoutZip.forEach((path, file) => {
      if (path === 'word/document.xml') {
        outputZip.file(path, mergedXml);
      } else {
        copyPromises.push(
          file.async('uint8array').then(data => outputZip.file(path, data))
        );
      }
    });
    await Promise.all(copyPromises);

    const outputBuf = await outputZip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    // Return as base64
    return res.status(200).json({ docxBase64: outputBuf.toString('base64') });

  } catch (err) {
    console.error('merge-layout error:', err);
    return res.status(500).json({ error: err.message });
  }
}
