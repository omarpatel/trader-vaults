// Singleton Prisma client. Importing ./env first guarantees DATABASE_URL
// is populated (root .env → apps/api/.env → dev default) before the
// client reads it.
import "./env.js";
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
