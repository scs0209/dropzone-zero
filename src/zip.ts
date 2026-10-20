import { inflateRawSync } from "node:zlib";

// A minimal ZIP reader, enough to pull the XML parts out of .docx, .xlsx, and .pptx
// files. It reads the central directory, so it never trusts sizes in local headers.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
// Office parts we read are small; the cap also stops zip bombs.
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

export interface ZipEntry {
  name: string;
  read(): Buffer;
}

export function listZipEntries(zip: Buffer): ZipEntry[] {
  // The end-of-central-directory record sits in the last 22 bytes plus an optional comment.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (zip.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a ZIP archive");

  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error("Corrupt ZIP directory");
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    entries.push({
      name,
      read() {
        if (size > MAX_ENTRY_BYTES) throw new Error(`ZIP entry too large: ${name}`);
        if (zip.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new Error("Corrupt ZIP entry");
        const start = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
        const data = zip.subarray(start, start + compressedSize);
        if (method === 0) return data;
        if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
        throw new Error(`Unsupported ZIP compression method ${method}`);
      },
    });
  }
  return entries;
}
