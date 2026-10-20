import { open, readFile } from "node:fs/promises";
import { extractText as extractPdfText, getDocumentProxy } from "unpdf";
import type { ScannedFile } from "./scan.js";
import { listZipEntries } from "./zip.js";

// Enough for a receipt or booking header; keeps prompts small and fast on a 4B model.
export const MAX_TEXT_CHARS = 2000;

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".tsv", ".json", ".ics", ".xml", ".html", ".log"]);
const OFFICE_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".bmp", ".tiff"]);
// Formats Ollama can decode. HEIC and others are classified from metadata only.
const VISION_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
// Ollama resizes images for the vision encoder itself; this only skips files too big to send sensibly.
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
// Text files are read from the start only, so a multi-gigabyte log costs nothing.
const TEXT_READ_BYTES = 64 * 1024;

export type ContentKind = "pdf" | "text" | "office" | "image" | "binary";

export interface ExtractedContent {
  kind: ContentKind;
  /** Text the model sees; empty for images and binaries. */
  text: string;
  truncated: boolean;
  /** Base64 image for the model's vision input, when the format and size allow it. */
  image?: string;
}

function clip(text: string): Pick<ExtractedContent, "text" | "truncated"> {
  const normalized = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  return normalized.length > MAX_TEXT_CHARS
    ? { text: normalized.slice(0, MAX_TEXT_CHARS), truncated: true }
    : { text: normalized, truncated: false };
}

export function contentKindOf(ext: string): ContentKind {
  if (ext === ".pdf") return "pdf";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (OFFICE_EXTENSIONS.has(ext)) return "office";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "binary";
}

async function readHead(path: string, bytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(bytes), 0, bytes, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Visible text of a .docx, .xlsx, or .pptx: paragraphs, shared cell strings, and slide text. */
export function officeText(zip: Buffer): string {
  const wanted = (name: string) =>
    name === "word/document.xml" ||
    name === "xl/workbook.xml" ||
    name === "xl/sharedStrings.xml" ||
    /^ppt\/slides\/slide\d+\.xml$/.test(name);
  const parts = listZipEntries(zip)
    .filter((entry) => wanted(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  return parts
    .map((entry) => {
      const xml = entry.read().toString("utf8");
      // Sheet names carry meaning ("Budget", "Transactions"); they live in attributes, not text nodes.
      const sheets = [...xml.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => `Sheet: ${m[1]}`);
      const text = xml
        .replace(/<\/(?:w:p|a:p|si)>/g, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/\n{2,}/g, "\n");
      return decodeXmlEntities([...sheets, text].join("\n"));
    })
    .join("\n");
}

/** Reads just enough of a file for the model to classify it. Never throws on unreadable content. */
export async function extractContent(file: ScannedFile): Promise<ExtractedContent> {
  const kind = contentKindOf(file.ext);
  if (file.size === 0) return { kind, text: "", truncated: false };

  try {
    if (kind === "text") {
      return { kind, ...clip(await readHead(file.path, TEXT_READ_BYTES)) };
    }
    if (kind === "office") {
      return { kind, ...clip(officeText(await readFile(file.path))) };
    }
    if (kind === "image" && VISION_EXTENSIONS.has(file.ext) && file.size <= MAX_IMAGE_BYTES) {
      // Gemma 4 is multimodal, so the model reads screenshots, photographed receipts, and tickets itself.
      return { kind, text: "", truncated: false, image: (await readFile(file.path)).toString("base64") };
    }
    if (kind === "pdf") {
      // unpdf bundles a serverless build of Mozilla's PDF.js, so real-world PDFs
      // (compressed streams, embedded fonts) work, not only the simple demo files.
      const pdf = await getDocumentProxy(new Uint8Array(await readFile(file.path)));
      const { text } = await extractPdfText(pdf, { mergePages: true });
      await pdf.cleanup();
      return { kind, ...clip(text) };
    }
  } catch {
    // Damaged or encrypted files fall through to metadata-only classification.
  }
  // Scanned PDFs (no text layer) could be rendered to an image for the vision path later.
  return { kind, text: "", truncated: false };
}
