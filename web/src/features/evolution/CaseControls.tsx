import { ArrowRight } from "lucide-react";
import type { KeyboardEvent } from "react";
import type { CasePlayback } from "./useCasePlayback";

export function tabKey(event: KeyboardEvent, index: number, total: number, select: (index: number) => void) {
  const next = event.key === "ArrowRight" ? (index + 1) % total : event.key === "ArrowLeft" ? (index - 1 + total) % total : event.key === "Home" ? 0 : event.key === "End" ? total - 1 : null;
  if (next === null) return;
  event.preventDefault();
  const list = event.currentTarget.parentElement;
  select(next);
  (list?.querySelectorAll<HTMLElement>('[role="tab"]')[next])?.focus();
}

export function CaseTabs({ playback }: { playback: CasePlayback }) {
  const { cases, state, dispatch } = playback;
  return <div className="evolution-case-tabs" role="tablist" aria-label="演化案例">
    {cases.map((item, index) => <button type="button" role="tab" id={`evolution-tab-${item.definition.id}`} aria-controls="evolution-case-panel" aria-selected={state.caseId === item.definition.id} tabIndex={state.caseId === item.definition.id ? 0 : -1} key={item.definition.id} onClick={() => dispatch({ type: "case", caseId: item.definition.id })} onKeyDown={event => tabKey(event, index, cases.length, next => dispatch({ type: "case", caseId: cases[next].definition.id }))}>
      <span className="case-index">0{index + 1}</span><span><strong>{item.definition.label}</strong><small>{item.definition.tagline}</small></span><ArrowRight size={17} aria-hidden="true" />
    </button>)}
  </div>;
}

export function DetailHeading({ index, label, title, children }: { index: string; label: string; title: string; children: React.ReactNode }) {
  return <div className="section-heading"><div className="section-kicker"><span>{index}</span><span>{label}</span></div><h2>{title}</h2><p>{children}</p></div>;
}
