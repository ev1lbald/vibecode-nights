import { parentPort, workerData } from "node:worker_threads";
import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";
import mammoth from "mammoth";

try {
  const { ext, bytes } = workerData;
  let text = "";
  if (ext === ".pdf") {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdf = await getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
    }).promise;
    if (pdf.numPages > 200) throw new Error("too many pages");
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text +=
        content.items.map((x) => ("str" in x ? x.str : "")).join(" ") + "\n";
      if (text.length > 50000) throw new Error("too much text");
    }
    await pdf.destroy();
  } else {
    let expanded = 0;
    const entries = unzipSync(new Uint8Array(bytes), {
      filter: (file) => {
        expanded += file.originalSize;
        if (expanded > 30 * 1024 * 1024 || file.originalSize > 10 * 1024 * 1024)
          throw new Error("archive too large");
        return ext === ".pptx"
          ? /^ppt\/slides\/slide\d+\.xml$/.test(file.name)
          : false;
      },
    });
    if (ext === ".docx")
      text = (await mammoth.extractRawText({ buffer: Buffer.from(bytes) }))
        .value;
    if (ext === ".pptx") {
      const parser = new XMLParser({
        ignoreAttributes: true,
        processEntities: false,
      });
      const collect = (node) =>
        typeof node === "string"
          ? node
          : typeof node === "number"
            ? String(node)
            : Array.isArray(node)
              ? node.map(collect).join(" ")
              : node && typeof node === "object"
                ? Object.entries(node)
                    .map(([key, value]) =>
                      key === "a:t"
                        ? collect(value)
                        : typeof value === "object"
                          ? collect(value)
                          : "",
                    )
                    .join(" ")
                : "";
      text = Object.keys(entries)
        .sort(
          (a, b) =>
            Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]),
        )
        .map((name) => collect(parser.parse(strFromU8(entries[name]))))
        .join("\n");
    }
  }
  parentPort.postMessage({ text });
} catch {
  parentPort.postMessage({ error: true });
}
