import fs from "fs";
import path from "path";
import { openApiSpec } from "./openapi";

// Build-time only: the production image ships dist/, not src/, so the spec
// must be materialised during `npm run build` rather than assembled at boot.
// Keeping it as a checked build artifact also lets CI fail on a broken spec.
const spec = openApiSpec as { openapi?: string; paths?: Record<string, unknown> };

if (spec.openapi !== "3.0.3" || !spec.paths || Object.keys(spec.paths).length === 0) {
  throw new Error("OpenAPI spec is invalid: expected 3.0.3 with at least one path");
}

const outPath = path.join(__dirname, "openapi.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(spec, null, 2));
console.log(`[openapi] Wrote ${Object.keys(spec.paths).length} paths to ${outPath}`);
