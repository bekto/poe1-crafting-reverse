// Loads the game data (and the manual files) from disk for the Node tests.
import fs from "node:fs";
import { loadDb } from "../public/js/engine/data.js";

export const DATA_DIR = new URL("../public/data/", import.meta.url);
export const db = await loadDb(async (path) => JSON.parse(fs.readFileSync(new URL(path, DATA_DIR))));
