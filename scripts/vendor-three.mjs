// Copies the pinned three.js build into the Zee app. The app's content security
// policy only allows scripts from the app itself, so nothing loads from a CDN.
// Runs before `pnpm app` and `pnpm app:build`.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules", "three");
const to = join(root, "app", "ui", "vendor");
await mkdir(to, { recursive: true });

for (const file of ["build/three.core.js", "build/three.module.js"]) {
  await writeFile(join(to, file.split("/").pop()), await readFile(join(from, file)));
}
// The addon imports the bare specifier "three"; point it at the copied module instead.
const rounded = await readFile(join(from, "examples/jsm/geometries/RoundedBoxGeometry.js"), "utf8");
await writeFile(join(to, "RoundedBoxGeometry.js"), rounded.replace(/from\s+['"]three['"]/g, "from './three.module.js'"));

const { version } = JSON.parse(await readFile(join(from, "package.json"), "utf8"));
console.log(`Vendored three.js ${version} into app/ui/vendor`);
