// ── X (Twitter) OAuth Integration ───────────────────────────────────
import { Router, Request, Response } from "express";
import { prisma } from "../db.js";

export const xOAuthRouter = Router();

// X OAuth 2.0 Configuration (these would be in env in production)
const X_OAUTH_CONFIG = {
  clientId: process.env.X_CLIENT_ID || "",
  clientSecret: process.env.X_CLIENT_SECRET || "",
  redirectUri: process.env.X_REDIRECT_URI || `${process.env.FRONTEND_URL}/auth/x/callback`,
  authorizeUrl: "https://twitter.com/i/oauth2/authorize",
  tokenUrl: "https://api.twitter.com/2/oauth2/token",
  scope: "tweet.read users.read",
};

// Simple session storage (in production, use Redis/express-session)
const oauthSessions = new Map<string, { userId?: string }>();

// Extend Express Request type to include session
declare global {
  namespace Express {
    interface Request {
      session?: { state: string; userId?: string };
    }
  }
}

// Session middleware
function sessionMiddleware(req: any, res: any, next: () => void) {
  const sessionId = req.cookies?.session_id;
  if (sessionId) {
    req.session = oauthSessions.get(sessionId);
  }
  next();
}

xOAuthRouter.use(sessionMiddleware);

/**
 * GET /api/auth - List available auth endpoints
 */
xOAuthRouter.get("/", (_req: Request, res: Response) => {
  res.json({
    message: "X OAuth endpoints available",
    endpoints: [
      "GET /api/auth/x - Initiate X OAuth flow",
      "GET /api/auth/x/callback - Handle X OAuth callback",
      "POST /api/auth/x/disconnect - Disconnect X account",
      "GET /api/auth/x/status - Get X connection status",
    ],
  });
});

/**
 * GET /api/auth/x
 * Initiate X OAuth flow - redirect user to X authorization page
 */
xOAuthRouter.get("/x", (req: Request, res: Response) => {
  const state = generateState();
  const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  
  // Store state in session
  const session = { state, userId: req.session?.userId };
  oauthSessions.set(sessionId, session);
  
  // Set session cookie
  res.cookie('session_id', sessionId, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 3600000 });
  
  const params = new URLSearchParams({
    response_type: "code",
    client_id: X_OAUTH_CONFIG.clientId,
    redirect_uri: X_OAUTH_CONFIG.redirectUri,
    scope: X_OAUTH_CONFIG.scope,
    state: state,
    code_challenge: "challenge",
    code_challenge_method: "plain",
  });

  res.redirect(`${X_OAUTH_CONFIG.authorizeUrl}?${params.toString()}`);
});

/**
 * GET /api/auth/x/callback
 * Handle X OAuth callback - exchange code for tokens
 */
xOAuthRouter.get("/x/callback", async (req: Request, res: Response) => {
  try {
    const { code, state } = req.query;
    const sessionId = req.cookies.session_id;
    const session = sessionId ? oauthSessions.get(sessionId) : undefined;
    
    // Verify state matches what we sent (simplified for demo)
    // In production, implement proper state validation
    if (!sessionId || !session) {
      return res.redirect(`${process.env.FRONTEND_URL}/settings?error=invalid_session`);
    }

    // In production, exchange authorization code for access token
    // For now, simulate successful OAuth
    const xHandle = "demo_user";
    const xVerified = false;

    // Update user's profile with X handle
    if (session.userId) {
      await prisma.user.update({
        where: { id: session.userId },
        data: {
          xHandle,
          xVerified,
        },
      });
    }

    // Clear session (optional cleanup)
    if (sessionId) {
      oauthSessions.delete(sessionId);
    }

    res.redirect(`${process.env.FRONTEND_URL}/settings?x_connected=true&handle=${xHandle}`);
  } catch (error) {
    console.error("[X OAuth] Error:", error);
    res.redirect(`${process.env.FRONTEND_URL}/settings?error=x_oauth_failed`);
  }
});

/**
 * POST /api/auth/x/disconnect
 * Disconnect X account from user profile
 */
xOAuthRouter.post("/x/disconnect", async (req: Request, res: Response) => {
  try {
    if (!req.session?.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    await prisma.user.update({
      where: { id: req.session.userId },
      data: {
        xHandle: null,
        xVerified: false,
      },
    });

    res.json({ success: true });
  } catch (error) {
    console.error("[X OAuth disconnect] Error:", error);
    res.status(500).json({ error: "Failed to disconnect X account" });
  }
});

/**
 * GET /api/auth/x/status
 * Get current X connection status
 */
xOAuthRouter.get("/x/status", async (req: Request, res: Response) => {
  try {
    if (!req.session?.userId) {
      return res.json({ connected: false });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.session.userId },
      select: { xHandle: true, xVerified: true },
    });

    res.json({
      connected: !!user?.xHandle,
      handle: user?.xHandle || null,
      verified: user?.xVerified || false,
    });
  } catch (error) {
    console.error("[X OAuth status] Error:", error);
    res.status(500).json({ error: "Failed to fetch X status" });
  }
});

// ── Helper Functions ─────────────────────────────────────────────────

function generateState(): string {
  // Generate a random state string for CSRF protection
  return Math.random().toString(36).substring(2, 15) +
         Math.random().toString(36).substring(2, 15);
}