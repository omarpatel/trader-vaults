#!/usr/bin/env node
// ── production (Postgres) Prisma driver ────────────────────────────
// PRODUCTION USES POSTGRES. SQLITE IS DEV-ONLY.
//
// apps/api/prisma/schema.prisma keeps `provider = "sqlite"` so a fresh
// clone runs locally with zero setup. This script emits the Postgres
// twin — apps/api/prisma/schema.prod.prisma, byte-identical except for
// the datasource provider — and runs Prisma commands against it with
// `--schema`. Nothing in the dev path changes.
//
// The emitted schema is a build artifact: regenerated on every build,
// gitignored, never hand-edited. Edit schema.prisma; this follows.
//
//   node scripts/prisma-prod.mjs emit       # write schema.prod.prisma
//   node scripts/prisma-prod.mjs validate   # + prisma validate
//   node scripts/prisma-prod.mjs generate   # + prisma generate (build)
//   node scripts/prisma-prod.mjs push       # + prisma db push  (start)
//
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(REPO_ROOT, "apps/api/prisma/schema.prisma");
const OUT = resolve(REPO_ROOT, "apps/api/prisma/schema.prod.prisma");

// A syntactically valid URL that connects to nothing. Offline commands
// (generate/validate) only need DATABASE_URL to *parse* as postgres —
// they never dial the database. Local dev has a `file:./dev.db` URL in
// .env, which would otherwise fail the provider check, so we stand this
// in for those two commands only. Commands that really touch the
// database (push) refuse to run without a genuine Postgres URL.
const PLACEHOLDER_URL = "postgresql://placeholder:placeholder@localhost:5432/placeholder";

function emitProdSchema() {
  const source = readFileSync(SRC, "utf8");

  // Rewrite the provider inside the `datasource` block only — the
  // `generator` block has its own `provider = "prisma-client-js"` line
  // that must survive untouched.
  let replaced = 0;
  const swapped = source.replace(
    /(datasource\s+\w+\s*\{[^}]*?provider\s*=\s*)"sqlite"/,
    (_match, head) => {
      replaced += 1;
      return `${head}"postgresql"`;
    },
  );

  if (replaced !== 1) {
    console.error(
      `[prisma-prod] expected exactly one sqlite datasource provider in ${SRC}, found ${replaced}.`,
    );
    console.error("[prisma-prod] the datasource block moved — fix scripts/prisma-prod.mjs.");
    process.exit(1);
  }

  const banner = [
    "// ─────────────────────────────────────────────────────────────────",
    "// GENERATED — DO NOT EDIT. Written by scripts/prisma-prod.mjs from",
    "// prisma/schema.prisma with the datasource provider swapped to",
    "// postgresql. Postgres is what PRODUCTION (Railway) uses; the sqlite",
    "// provider in schema.prisma is dev-only. Edit the source schema.",
    "// ─────────────────────────────────────────────────────────────────",
    "",
    "",
  ].join("\n");

  writeFileSync(OUT, banner + swapped, "utf8");
  console.log("[prisma-prod] wrote apps/api/prisma/schema.prod.prisma (provider: postgresql)");
}

function prismaBin() {
  const require = createRequire(resolve(REPO_ROOT, "package.json"));
  const pkgJson = require.resolve("prisma/package.json");
  return resolve(dirname(pkgJson), "build/index.js");
}

function runPrisma(args, { allowPlaceholderUrl }) {
  const url = process.env.DATABASE_URL ?? "";
  const isPostgres = /^postgres(ql)?:\/\//.test(url);
  const envOverrides = {};

  if (!isPostgres) {
    if (allowPlaceholderUrl) {
      envOverrides.DATABASE_URL = PLACEHOLDER_URL;
      console.log(
        "[prisma-prod] DATABASE_URL is not Postgres — using a parse-only placeholder " +
          "(this command never connects).",
      );
    } else {
      console.error(
        "[prisma-prod] refusing to run against a non-Postgres DATABASE_URL: " +
          (url ? `${url.split(":")[0]}:…` : "(unset)"),
      );
      console.error(
        "[prisma-prod] production requires DATABASE_URL=postgresql://… " +
          "(Railway sets it when a Postgres service is attached).",
      );
      process.exit(1);
    }
  }

  const full = [...args, "--schema", OUT];
  console.log(`[prisma-prod] prisma ${full.join(" ")}`);
  const result = spawnSync(process.execPath, [prismaBin(), ...full], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, ...envOverrides },
  });
  if (result.error) {
    console.error("[prisma-prod] failed to launch prisma:", result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

const command = process.argv[2];
emitProdSchema();

switch (command) {
  case undefined:
  case "emit":
    break;
  case "validate":
    runPrisma(["validate"], { allowPlaceholderUrl: true });
    break;
  case "generate":
    runPrisma(["generate"], { allowPlaceholderUrl: true });
    break;
  case "push":
    // Real connection: needs the genuine Railway Postgres URL.
    runPrisma(["db", "push", "--skip-generate"], { allowPlaceholderUrl: false });
    break;
  default:
    console.error(`[prisma-prod] unknown command "${command}" (emit|validate|generate|push)`);
    process.exit(1);
}
