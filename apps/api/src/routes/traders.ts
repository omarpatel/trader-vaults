import { Router } from "express";
import { prisma } from "../db.js";
import { getTraderView } from "../services/traders.js";
import { getDemoUser } from "../services/vaults.js";

export const tradersRouter = Router();

// X usernames: 1-15 chars, letters/digits/underscore (leading @ stripped).
const X_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

/** Assemble the shared TraderProfile for a user via the existing profile
 *  assembly (getTraderView), so /me agrees with the public page — except
 *  xVerified: X linking is display-only until real X OAuth ships. Any
 *  xHandle on the /me user is self-entered through this editor, so both
 *  /me endpoints force the verified badge OFF (which also guarantees the
 *  invariant "xVerified is false whenever xHandle changes"), overriding
 *  the P0 "linked ⇒ verified" heuristic in toTraderProfile. */
async function assembleOwnProfile(handle: string) {
  const view = await getTraderView(handle);
  return view ? { ...view.trader, xVerified: false } : undefined;
}

// ── /me — the signed-in user's own profile ─────────────────────────
// P0 runs without auth: "me" resolves to the demo user exactly the way
// vault creation does (getDemoUser upsert on handle "you"). The Privy
// integration replaces this with a session lookup. Registered BEFORE
// /:handle so "me" never falls through to the public-handle lookup.

// GET /api/traders/me → { trader: TraderProfile }
tradersRouter.get("/me", async (_req, res, next) => {
  try {
    const user = await getDemoUser();
    const trader = await assembleOwnProfile(user.handle);
    if (!trader) {
      res.status(404).json({ error: "trader not found" });
      return;
    }
    res.json({ trader });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/traders/me { displayName?, bio?, xHandle?, avatarUrl? }
// Partial update of the demo user's profile → { trader: TraderProfile }.
// Empty string on bio / xHandle / avatarUrl clears the field.
tradersRouter.patch("/me", async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const data: {
      displayName?: string;
      bio?: string | null;
      xHandle?: string | null;
      avatarUrl?: string | null;
    } = {};

    if ("displayName" in body) {
      if (typeof body.displayName !== "string") {
        res.status(400).json({ error: "displayName must be a string" });
        return;
      }
      const name = body.displayName.trim();
      if (name.length < 2 || name.length > 30) {
        res.status(400).json({ error: "displayName must be 2-30 characters" });
        return;
      }
      data.displayName = name;
    }

    if ("bio" in body) {
      if (typeof body.bio !== "string") {
        res.status(400).json({ error: "bio must be a string" });
        return;
      }
      const bio = body.bio.trim();
      if (bio.length > 240) {
        res.status(400).json({ error: "bio must be 240 characters or fewer" });
        return;
      }
      data.bio = bio || null;
    }

    if ("xHandle" in body) {
      if (typeof body.xHandle !== "string") {
        res.status(400).json({ error: "xHandle must be a string" });
        return;
      }
      const xHandle = body.xHandle.trim().replace(/^@+/, "");
      if (xHandle && !X_HANDLE_RE.test(xHandle)) {
        res
          .status(400)
          .json({ error: "xHandle must be 1-15 letters, digits or underscores" });
        return;
      }
      data.xHandle = xHandle || null; // empty string clears the link
    }

    if ("avatarUrl" in body) {
      if (typeof body.avatarUrl !== "string") {
        res.status(400).json({ error: "avatarUrl must be a string" });
        return;
      }
      const avatarUrl = body.avatarUrl.trim();
      if (avatarUrl) {
        let ok = false;
        try {
          const u = new URL(avatarUrl);
          ok = u.protocol === "http:" || u.protocol === "https:";
        } catch {
          /* not a URL */
        }
        if (!ok) {
          res.status(400).json({ error: "avatarUrl must be an http(s) URL" });
          return;
        }
      }
      data.avatarUrl = avatarUrl || null; // empty string clears the avatar
    }

    if (Object.keys(data).length === 0) {
      res.status(400).json({
        error: "nothing to update — provide displayName, bio, xHandle or avatarUrl",
      });
      return;
    }

    const user = await getDemoUser();
    const updated = await prisma.user.update({ where: { id: user.id }, data });
    const trader = await assembleOwnProfile(updated.handle);
    if (!trader) {
      res.status(404).json({ error: "trader not found" });
      return;
    }
    res.json({ trader }); // xVerified already forced false by assembleOwnProfile

  } catch (err) {
    next(err);
  }
});

// GET /api/traders/:handle — public trader profile: identity + their
// vaults (full shared Vault shapes) + aggregate totals across them.
tradersRouter.get("/:handle", async (req, res, next) => {
  try {
    const view = await getTraderView(req.params.handle);
    if (!view) {
      res.status(404).json({ error: "trader not found" });
      return;
    }
    res.json(view);
  } catch (err) {
    next(err);
  }
});
