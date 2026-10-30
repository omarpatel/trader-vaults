// Runs the Prisma CLI with the same env the API sees: root .env → apps/api/.env
// → process.env, plus the dev DATABASE_URL default. Without this the CLI only
// reads apps/api/.env and fails on a fresh clone.
import { spawnSync } from "node:child_process";
import "../src/env.js";

const { status } = spawnSync("prisma", process.argv.slice(2), { stdio: "inherit", shell: true });
process.exit(status ?? 1);
