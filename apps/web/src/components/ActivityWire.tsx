import { Link } from "react-router-dom";
import type { ActivityEvent } from "@trader-vaults/shared";
import { api } from "../lib/api";
import { usePoll } from "../lib/hooks";

function tone(kind: ActivityEvent["kind"], side?: string): string {
  if (kind === "order_fill") return "pos";
  if (kind === "trade") return side === "buy" ? "pos" : "neg";
  if (kind === "withdraw_request" || kind === "withdraw_paid") return "neg";
  return "mutedtx";
}

/** Live platform events as a teletype strip. Polls every 10s. */
export function ActivityWire() {
  const { data: events } = usePoll(() => api.activity(30), 10_000, []);
  if (!events || events.length === 0) return null;
  const doubled = [...events, ...events];
  return (
    <div className="tickerwrap wire-bottom" aria-label="Live platform activity">
      <div className="ticker" style={{ animationDuration: `${Math.max(30, events.length * 4)}s` }}>
        {doubled.map((e, i) => (
          <span key={`${e.id}-${i}`} className="titem">
            <span className="dimtx">
              {new Date(e.ts * 1000).toLocaleTimeString([], { hour12: false })}
            </span>
            {e.vaultId ? (
              <Link to={`/vault/${e.vaultId}`} className={tone(e.kind, e.side)}>
                {e.text}
              </Link>
            ) : (
              <span className={tone(e.kind, e.side)}>{e.text}</span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}
