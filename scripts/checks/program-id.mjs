#!/usr/bin/env node
/**
 * The program id must be the same string in every place that names it.
 *
 * B14: Anchor.toml carried the placeholder Fg6PaFpo… while declare_id! and
 * PROGRAM_ID.txt both said HWssGCcx…. lib.rs's own comment warns that a
 * mismatch makes every PDA derivation and CPI signature wrong at RUNTIME,
 * not at build time — so nothing catches it until money is moving.
 *
 *   node scripts/checks/program-id.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const sources = {
  "programs/vault/PROGRAM_ID.txt": read("programs/vault/PROGRAM_ID.txt").trim(),
  "programs/vault/programs/vault/src/lib.rs":
    read("programs/vault/programs/vault/src/lib.rs").match(/declare_id!\("([^"]+)"\)/)?.[1],
  "programs/vault/Anchor.toml":
    read("programs/vault/Anchor.toml").match(/^vault = "([^"]+)"/m)?.[1],
  "apps/api/src/env.ts":
    read("apps/api/src/env.ts").match(/VAULT_PROGRAM_ID",\s*"([^"]+)"/)?.[1],
};

let bad = false;
const values = new Set();
for (const [file, id] of Object.entries(sources)) {
  if (!id) {
    console.error(`  MISSING  ${file} — could not find a program id`);
    bad = true;
    continue;
  }
  values.add(id);
  console.log(`  ${id}  ${file}`);
}

// Anchor.toml may legitimately list several clusters; every one must agree.
const anchorIds =
  read("programs/vault/Anchor.toml").match(/^vault = "([^"]+)"/gm)?.map((l) => l.split('"')[1]) ?? [];
for (const id of anchorIds) values.add(id);

if (values.size > 1) {
  console.error(`\nFAIL — ${values.size} different program ids: ${[...values].join(", ")}`);
  process.exit(1);
}
if (bad) process.exit(1);
console.log(`\nOK — one program id everywhere: ${[...values][0]}`);
