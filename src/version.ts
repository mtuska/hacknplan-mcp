/** Single source of truth for the version: the published package.json. */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// dist/version.js -> ../package.json (package root, always shipped by npm).
const pkg = require("../package.json") as { version: string };

export const VERSION: string = pkg.version;
