import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { type Project } from "../pipeline";
import { claudeSalesCallGuide, claudeRegenerateSalesCallGuide } from "../api";

// The sales call guide, opened from the button at the top of the project page. Michael asked for
// this on the 08-31 Kelvin's Corner recording: a per-inquiry cheat sheet he can have open during a
// live call, generated automatically rather than on request, customised by event type.
//
// The guide itself is markdown written by Claude (see crm-claude.mjs / templates/sales-call-guide).
// This file only renders it. The renderer is deliberately hand-rolled and tiny: the guide uses six
// markdown constructs and pulling in a parser for that would be silly.
//
// The one interactive thing is that every bullet can be clicked to strike it out. On a live call
// that is the difference between "I think I asked that" and knowing. State is per-open on purpose:
// each call starts clean.

// '2026-08-31T18:04:11.000Z' -> 'Aug 31, 2026, 2:04 PM'
function fmtWhen(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const TYPE_LABEL: Record<string, string> = {
  corporate: "Corporate",
  wedding: "Wedding",
  private: "Private event",
};

// **bold** and *italic*, escaped first so a stray < in the guide cannot inject markup.
function inline(text: string): string {
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc
    .replace(
      /\*\*([^*]+)\*\*/g,
      '<strong class="font-semibold text-parchment">$1</strong>',
    )
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(
      /`([^`]+)`/g,
      '<code class="rounded bg-surface-3 px-1 py-0.5 text-[12px]">$1</code>',
    );
}

type Block =
  | { kind: "h2"; text: string; n: number }
  | { kind: "h3"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "bullet"; text: string; id: string }
  | { kind: "p"; text: string }
  | { kind: "rule" };

function parse(md: string): Block[] {
  const out: Block[] = [];
  let phase = 0;
  const lines = md.replace(/\r/g, "").split("\n");
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    if (!line.trim()) return;
    if (/^#{3,}\s/.test(line))
      return out.push({ kind: "h3", text: line.replace(/^#{3,}\s*/, "") });
    if (/^##\s/.test(line)) {
      phase += 1;
      return out.push({
        kind: "h2",
        text: line.replace(/^##\s*/, ""),
        n: phase,
      });
    }
    if (/^#\s/.test(line)) {
      phase += 1;
      return out.push({
        kind: "h2",
        text: line.replace(/^#\s*/, ""),
        n: phase,
      });
    }
    if (/^\s*[-*]{3,}\s*$/.test(line)) return out.push({ kind: "rule" });
    if (/^>\s?/.test(line))
      return out.push({ kind: "quote", text: line.replace(/^>\s?/, "") });
    if (/^\s*[-*+]\s+/.test(line))
      return out.push({
        kind: "bullet",
        text: line.replace(/^\s*[-*+]\s+/, ""),
        id: `b${i}`,
      });
    if (/^\s*\d+[.)]\s+/.test(line))
      return out.push({
        kind: "bullet",
        text: line.replace(/^\s*\d+[.)]\s*/, ""),
        id: `b${i}`,
      });
    out.push({ kind: "p", text: line });
  });
  return out;
}

// The body is mounted fresh every time the dialog opens (see the conditional render below), so
// "reset on open" is just initial state rather than an effect that fights the render.
function GuideBody({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const [guide, setGuide] = useState("");
  const [generatedAt, setGeneratedAt] = useState("");
  const [type, setType] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [struck, setStruck] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    claudeSalesCallGuide(project.id)
      .then((r) => {
        if (!alive) return;
        setGuide(r.guide);
        setGeneratedAt(r.generatedAt);
        setType(r.type);
      })
      .catch((e) => alive && setError(String(e?.message || e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [project.id]);

  const regenerate = () => {
    setBusy(true);
    setError("");
    claudeRegenerateSalesCallGuide(project.id)
      .then((r) => {
        setGuide(r.guide);
        setGeneratedAt(r.generatedAt);
        setType(r.type);
        setStruck({});
      })
      .catch((e) => setError(String(e?.message || e)))
      .finally(() => setBusy(false));
  };

  const blocks = useMemo(() => parse(guide), [guide]);

  return (
    <motion.div
      className="relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_30px_70px_-30px_rgba(0,0,0,0.18)]"
      initial={{ y: 16, opacity: 0.6, scale: 0.98 }}
      animate={{ y: 0, opacity: 1, scale: 1 }}
      exit={{ y: 16, opacity: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="flex items-start justify-between gap-4 border-b border-line px-6 pb-4 pt-5">
        <div className="min-w-0">
          <h2 className="font-display text-[20px] leading-tight text-parchment">
            Sales call guide
          </h2>
          <p className="mt-1 text-[12.5px] text-muted">
            <span className="text-parchment">{project.client}</span>
            {type ? ` · ${TYPE_LABEL[type] || type}` : ""}
            {generatedAt ? ` · written ${fmtWhen(generatedAt)}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={regenerate}
            disabled={busy}
            title="Rebuild the guide from the current project data"
            className="rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-semibold text-muted transition-colors hover:border-brass-dim hover:text-brass-bright disabled:opacity-50"
          >
            {busy ? "Writing..." : "Rebuild"}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg border border-line p-1.5 text-muted transition-colors hover:border-line-strong hover:text-parchment"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </div>

      <div className="board-scroll min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {loading && <p className="text-[13px] text-muted">Loading...</p>}

        {!loading && error && (
          <p className="rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-[13px] text-muted">
            {error}
          </p>
        )}

        {!loading && !error && !guide && (
          <div className="rounded-lg border border-line bg-surface-2 px-4 py-6 text-center">
            <p className="text-[13.5px] text-parchment">
              No guide yet for this project.
            </p>
            <p className="mx-auto mt-1.5 max-w-md text-[12.5px] leading-relaxed text-muted">
              Guides are written automatically for projects in the early stages,
              within about ten minutes of the inquiry landing. Press Rebuild to
              write one now.
            </p>
          </div>
        )}

        {!loading && !error && guide && (
          <div className="space-y-1">
            {blocks.map((b, i) => {
              if (b.kind === "rule")
                return <hr key={i} className="my-4 border-line" />;
              if (b.kind === "h2")
                return (
                  <div
                    key={i}
                    className="flex items-center gap-2.5 pb-1.5 pt-5 first:pt-0"
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brass text-[12px] font-semibold text-white">
                      {b.n}
                    </span>
                    <h3 className="font-display text-[16.5px] leading-tight text-parchment">
                      {b.text}
                    </h3>
                    <span className="ml-1 h-px flex-1 bg-line" />
                  </div>
                );
              if (b.kind === "h3")
                return (
                  <h4
                    key={i}
                    className="pb-0.5 pt-3.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-faint"
                    dangerouslySetInnerHTML={{ __html: inline(b.text) }}
                  />
                );
              if (b.kind === "quote")
                return (
                  <blockquote
                    key={i}
                    className="my-1.5 rounded-r-lg border-l-[3px] border-brass bg-surface-2 py-2 pl-3.5 pr-3 text-[13.5px] italic leading-relaxed text-parchment"
                    dangerouslySetInnerHTML={{ __html: inline(b.text) }}
                  />
                );
              if (b.kind === "bullet") {
                const done = !!struck[b.id];
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() =>
                      setStruck((s) => ({ ...s, [b.id]: !s[b.id] }))
                    }
                    className="flex w-full items-start gap-2.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-surface-2"
                  >
                    <span
                      className={[
                        "mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                        done
                          ? "border-brass bg-brass text-white"
                          : "border-line-strong",
                      ].join(" ")}
                    >
                      {done && (
                        <svg
                          viewBox="0 0 24 24"
                          className="h-3 w-3"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M5 12.5l5 5L19 7" />
                        </svg>
                      )}
                    </span>
                    <span
                      className={[
                        "text-[13.5px] leading-relaxed",
                        done ? "text-faint line-through" : "text-muted",
                      ].join(" ")}
                      dangerouslySetInnerHTML={{ __html: inline(b.text) }}
                    />
                  </button>
                );
              }
              return (
                <p
                  key={i}
                  className="px-1.5 py-1 text-[13.5px] leading-relaxed text-muted"
                  dangerouslySetInnerHTML={{ __html: inline(b.text) }}
                />
              );
            })}
          </div>
        )}
      </div>
    </motion.div>
  );
}

export function SalesCallGuideModal({
  open,
  project,
  onClose,
}: {
  open: boolean;
  project: Project;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
            onClick={onClose}
            aria-hidden
          />
          <GuideBody project={project} onClose={onClose} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
