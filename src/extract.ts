import { readFile } from "node:fs/promises";
import { extractText as extractPdfText, getDocumentProxy } from "unpdf";
import type { ScannedFile } from "./scan.js";

// Enough for a receipt or booking header; keeps prompts small and fast on a 4B model.
export const MAX_TEXT_CHARS = 2000;

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".tsv", ".json", ".ics", ".xml", ".html", ".log"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".bmp", ".tiff"]);

export type ContentKind = "pdf" | "text" | "image" | "binary";

export interface ExtractedContent {
  kind: ContentKind;
  /** Text the model sees; empty for images and binaries, which are described by metadata only. */
  text: string;
  truncated: boolean;
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
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "binary";
}

/** Reads just enough of a file for the model to classify it. Never throws on unreadable content. */
export async function extractContent(file: ScannedFile): Promise<ExtractedContent> {
  const kind = contentKindOf(file.ext);
  if (file.size === 0) return { kind, text: "", truncated: false };

  try {
    if (kind === "text") {
      return { kind, ...clip(await readFile(file.path, "utf8")) };
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
  // Images: metadata only for now. Gemma 4 is multimodal, so a later version can
  // pass a downscaled copy through Ollama's `images` field to read screenshots and photos.
  return { kind, text: "", truncated: false };
}
