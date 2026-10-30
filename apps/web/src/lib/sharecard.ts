/**
 * PnL share card — 1200x675 PNG drawn on an offscreen canvas.
 * Faithful to theme.css v3: ink ground, dot grid, one amber, hard 1px rules,
 * Space Mono display numbers. No gradients, no rounding.
 */
import { fmtSol } from "@trader-vaults/shared";

export interface ShareCardInput {
  vaultName: string;
  pnlPct: number;
  pnlSol: number;
  sinceLabel: string;
  handle: string;
}

const W = 1200;
const H = 675;
const PAD = 52;

const INK = "#0a0a08";
const AMBER = "#ffb000";
const GREEN = "#2fd980";
const RED = "#ff4f58";
const MUTED = "#9a968a";
const DOT = "rgba(233, 230, 218, 0.08)";

function font(weight: 400 | 700, px: number): string {
  return `${weight} ${px}px 'Space Mono', monospace`;
}

/** Shrink from `px` until `text` fits `maxWidth`. Leaves ctx.font set. */
function fitFont(
  ctx: CanvasRenderingContext2D,
  text: string,
  weight: 400 | 700,
  px: number,
  maxWidth: number,
): void {
  let size = px;
  ctx.font = font(weight, size);
  while (size > 24 && ctx.measureText(text).width > maxWidth) {
    size -= 4;
    ctx.font = font(weight, size);
  }
}

export async function renderShareCard(card: ShareCardInput): Promise<Blob> {
  // The page already loads Space Mono; make sure the canvas can use it too.
  try {
    await Promise.all([
      document.fonts.load("700 140px 'Space Mono'"),
      document.fonts.load("400 24px 'Space Mono'"),
    ]);
  } catch {
    /* fallback monospace still reads fine */
  }

  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");

  // ── ink ground + dot grid (22px pitch, same as the app shell) ──
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = DOT;
  for (let y = 11; y < H; y += 22) {
    for (let x = 11; x < W; x += 22) {
      ctx.fillRect(x, y, 2, 2);
    }
  }

  const tone = card.pnlPct >= 0 ? GREEN : RED;

  // ── wordmark: amber block + TRADER VAULTS ──
  ctx.fillStyle = AMBER;
  ctx.fillRect(PAD, 46, 40, 40);
  ctx.fillStyle = INK;
  ctx.font = font(700, 26);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("V", PAD + 20, 68);
  ctx.textAlign = "left";
  ctx.fillStyle = AMBER;
  ctx.font = font(700, 30);
  ctx.fillText("TRADER VAULTS", PAD + 58, 67);

  // ── since label, top-right ──
  ctx.fillStyle = MUTED;
  ctx.font = font(400, 20);
  ctx.textAlign = "right";
  ctx.fillText(card.sinceLabel.toUpperCase(), W - PAD, 67);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  // ── vault name + handle, amber ──
  const name = card.vaultName.toUpperCase();
  fitFont(ctx, name, 700, 52, W - PAD * 2);
  ctx.fillStyle = AMBER;
  ctx.fillText(name, PAD, 212);
  ctx.globalAlpha = 0.85;
  ctx.font = font(400, 26);
  ctx.fillText(`@${card.handle}`, PAD, 254);
  ctx.globalAlpha = 1;

  // ── the number ──
  const pctText = `${card.pnlPct >= 0 ? "+" : ""}${card.pnlPct.toFixed(1)}%`;
  ctx.font = "700 140px 'Space Mono', monospace";
  if (ctx.measureText(pctText).width > W - PAD * 2) {
    fitFont(ctx, pctText, 700, 140, W - PAD * 2);
  }
  ctx.fillStyle = tone;
  ctx.fillText(pctText, PAD - 6, 452); // -6: Space Mono side bearing

  // ── sol delta + caption ──
  const solText = `${card.pnlSol >= 0 ? "+" : ""}${fmtSol(card.pnlSol)} ◎`;
  ctx.font = font(700, 34);
  ctx.fillText(solText, PAD, 518);
  const solW = ctx.measureText(solText).width;
  ctx.fillStyle = MUTED;
  ctx.font = font(400, 20);
  ctx.fillText("UNREALIZED PNL", PAD + solW + 24, 518);

  // ── bottom bar: amber slab, ink type ──
  ctx.fillStyle = AMBER;
  ctx.fillRect(13, H - 67, W - 26, 54);
  ctx.fillStyle = INK;
  ctx.font = font(700, 20);
  ctx.textBaseline = "middle";
  ctx.fillText("trader vaults on solana", PAD, H - 39);
  ctx.textBaseline = "alphabetic";

  // ── hard 1px amber border, inset ──
  ctx.strokeStyle = AMBER;
  ctx.lineWidth = 1;
  ctx.strokeRect(12.5, 12.5, W - 25, H - 25);

  const blob = await new Promise<Blob | null>((resolve) => cv.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("PNG encode failed");
  return blob;
}
