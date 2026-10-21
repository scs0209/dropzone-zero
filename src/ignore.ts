// .dropzoneignore: files and folders Dropzone Zero leaves completely alone. A file
// that matches is never read, never shown to a model, never indexed for search, and
// never moved. One pattern per line, in the folder being organized:
//
//   # comments start with #
//   *.key          by name, anywhere
//   Taxes/         a folder and everything in it
//   Scans/*.pdf    by path from the folder
//
// `*` matches within one name, `**` across folders, `?` one character.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const IGNORE_FILE = ".dropzoneignore";

function toRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      source += ".*";
      i++;
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

/** Returns a test for paths relative to the folder ("a/b.pdf"); nothing is ignored without the file. */
export function loadIgnore(inbox: string): (path: string) => boolean {
  let text = "";
  try {
    text = readFileSync(join(inbox, IGNORE_FILE), "utf8");
  } catch {
    return () => false;
  }
  return ignoreMatcher(text);
}

export function ignoreMatcher(text: string): (path: string) => boolean {
  const rules = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const folder = line.endsWith("/");
      const pattern = line.replace(/^\/+|\/+$/g, "");
      // A bare name matches in any folder; a pattern with a slash is a path from the top.
      const anywhere = !pattern.includes("/");
      return { folder, anywhere, regex: toRegExp(pattern) };
    });
  return (path) => {
    const parts = path.split("/");
    return rules.some(({ folder, anywhere, regex }) => {
      // A folder rule matches the folder itself or anything under it.
      if (folder) return parts.some((part, i) => (anywhere ? regex.test(part) : regex.test(parts.slice(0, i + 1).join("/"))));
      return anywhere ? regex.test(parts.at(-1)!) : regex.test(path);
    });
  };
}
