import { useEffect } from "react";
import type { ToolFileView } from "../lib/toolCards";
import { DiffPreview } from "./ToolCard";
import { NumberedCode } from "../lib/highlight";

export function FileViewer({
  view,
  onClose,
}: {
  view: ToolFileView;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="viewer" onClick={onClose}>
      <div className="viewer__panel" onClick={(e) => e.stopPropagation()}>
        <div className="viewer__head">
          <span title={view.title}>
            {view.language && (
              <span style={{ color: "var(--dsw-alias-label-caption)" }}>
                {view.language} ·{" "}
              </span>
            )}
            {view.title}
          </span>
          <button
            type="button"
            className="viewer__close"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="viewer__scroll">
          {view.imageSrc ? (
            <img
              className="viewer__image"
              src={view.imageSrc}
              alt={view.title}
            />
          ) : view.content === undefined ? (
            view.diff ? (
              <DiffPreview diff={view.diff} />
            ) : null
          ) : (
            <NumberedCode code={view.content} language={view.language} />
          )}
        </div>
      </div>
    </div>
  );
}
