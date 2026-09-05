import { useState } from "react";
import type { AskQuestion } from "../lib/askBlock";
import { IconChevronDown } from "./icons";

/** Pseudo-option: every question also offers a free-text answer. */
const OTHER = "__other__";

function IconClose({ size = 14 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 14 14"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path
        d="M3.5 3.5 10.5 10.5M10.5 3.5 3.5 10.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * One clarifying question at a time, Claude-style: step badge, stacked
 * options, Skip / Next. Read-only (no onAnswer) for every reply but the
 * newest — an answered card is history.
 */
export function AskCard({
  questions,
  onAnswer,
}: {
  questions: AskQuestion[];
  onAnswer?: (text: string) => void;
}) {
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [typed, setTyped] = useState<Record<number, string>>({});
  const [sent, setSent] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const interactive = Boolean(onAnswer) && !sent;
  const index = Math.min(step, Math.max(questions.length - 1, 0));
  const question = questions[index];
  if (dismissed)
    return <p className="ask-card__dismissed">Questions dismissed.</p>;
  if (!question) return null;

  const multi = question.multiSelect === true;
  const chosen = picked[index] ?? [];
  const last = index === questions.length - 1;
  const currentLabels = chosen
    .map((label) => (label === OTHER ? typed[index]?.trim() : label))
    .filter((label): label is string => Boolean(label));
  const canNext = currentLabels.length > 0;

  const toggle = (label: string) => {
    if (!interactive) return;
    setPicked((current) => {
      const now = current[index] ?? [];
      if (!multi)
        return { ...current, [index]: now[0] === label ? [] : [label] };
      return {
        ...current,
        [index]: now.includes(label)
          ? now.filter((entry) => entry !== label)
          : [...now, label],
      };
    });
  };

  const answers = questions
    .map((entry, questionIndex) => {
      const labels = (picked[questionIndex] ?? [])
        .map((label) =>
          label === OTHER ? typed[questionIndex]?.trim() : label,
        )
        .filter((label): label is string => Boolean(label));
      return labels.length > 0
        ? `${entry.question} — ${labels.join(", ")}`
        : null;
    })
    .filter((line): line is string => line !== null);

  const submit = () => {
    if (!interactive || answers.length === 0) return;
    setSent(true);
    onAnswer!(answers.join("\n"));
  };

  const goNext = () => {
    if (last) {
      if (interactive) submit();
      return;
    }
    if (interactive && !canNext) return;
    setStep((current) => current + 1);
  };

  const skip = () => {
    if (last) {
      if (interactive) {
        if (answers.length > 0) submit();
        else setDismissed(true);
      }
      return;
    }
    setStep((current) => current + 1);
  };

  const options = [...question.options, { label: OTHER }];

  return (
    <div className={`ask-card${interactive ? "" : " is-locked"}`}>
      <div className="ask-card__top">
        <span className="ask-card__step">
          {index + 1}/{questions.length}
        </span>
        <p className="ask-card__prompt">{question.question}</p>
        <div className="ask-card__tools">
          <button
            type="button"
            className="ask-card__icon-btn"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand" : "Collapse"}
            onClick={() => setCollapsed((current) => !current)}
          >
            <span
              className={`ask-card__chevron${collapsed ? " is-closed" : ""}`}
            >
              <IconChevronDown size={14} />
            </span>
          </button>
          <button
            type="button"
            className="ask-card__icon-btn"
            aria-label="Dismiss"
            onClick={() => setDismissed(true)}
          >
            <IconClose />
          </button>
        </div>
      </div>
      {!collapsed && (
        <>
          <div className="ask-card__options" role="group">
            {options.map((option, optionIndex) => {
              const isOther = option.label === OTHER;
              const isPicked = chosen.includes(option.label);
              return (
                <div
                  key={isOther ? OTHER : option.label}
                  role="button"
                  tabIndex={interactive ? 0 : -1}
                  aria-pressed={isPicked}
                  className={`ask-card__option${isPicked ? " is-picked" : ""}${isOther ? " ask-card__option--other" : ""}`}
                  onClick={() => toggle(option.label)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggle(option.label);
                    }
                  }}
                >
                  <span className="ask-card__option-body">
                    <strong>{isOther ? "Other" : option.label}</strong>
                    {!isOther && option.description && (
                      <em>{option.description}</em>
                    )}
                    {isOther && (
                      <input
                        className="ask-card__typed"
                        type="text"
                        disabled={!interactive}
                        placeholder="Type your own answer here"
                        value={typed[index] ?? ""}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => {
                          const value = event.target.value;
                          setTyped((current) => ({
                            ...current,
                            [index]: value,
                          }));
                          if (!value.trim()) return;
                          setPicked((current) => {
                            const now = current[index] ?? [];
                            if (now.includes(OTHER)) return current;
                            if (!multi)
                              return { ...current, [index]: [OTHER] };
                            return { ...current, [index]: [...now, OTHER] };
                          });
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            event.stopPropagation();
                            goNext();
                          }
                        }}
                      />
                    )}
                  </span>
                  <span className="ask-card__num">{optionIndex + 1}</span>
                </div>
              );
            })}
          </div>
          {!sent && (interactive || questions.length > 1) && (
            <div className="ask-card__foot">
              <button
                type="button"
                className="ask-card__skip"
                onClick={skip}
              >
                Skip
              </button>
              <button
                type="button"
                className="ask-card__next"
                disabled={interactive && !canNext}
                onClick={goNext}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
