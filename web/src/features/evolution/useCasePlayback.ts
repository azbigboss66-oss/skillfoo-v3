import { useCallback, useEffect, useState } from "react";
import definitions from "../../data/evolution-cases.json";
import { buildCases, findCase, initialPlayback, reducePlayback } from "./caseEngine";
import type { CaseDefinition, CaseId, EvolutionCase, PlaybackAction } from "./types";

let libraryPromise: Promise<EvolutionCase[]> | undefined;
export function useCaseLibrary() {
  const [cases, setCases] = useState<EvolutionCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    libraryPromise ??= buildCases(definitions as CaseDefinition[]);
    libraryPromise.then(value => { if (active) setCases(value); }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "案例初始化失败"); });
    return () => { active = false; };
  }, []);
  return { cases, error };
}

export function useCasePlayback(cases: EvolutionCase[], reduced: boolean) {
  const [state, setState] = useState(() => initialPlayback(cases[0]));
  // V2 is a manual explorer. Legacy playback actions remain pure reducer contracts,
  // but this mounted hook never starts a clock or permits automatic advancement.
  const dispatch = useCallback((action: PlaybackAction) => setState(previous => {
    if (action.type === 'step' && action.automatic) return previous;
    return { ...reducePlayback(previous, action, cases), playing: false };
  }), [cases]);
  const current = findCase(cases, state.caseId);
  const event = current.events[state.eventIndex];
  const locateCandidate = useCallback((caseId: CaseId, candidateId: string) => {
    const candidate = findCase(cases, caseId).byId[candidateId];
    if (!candidate) return;
    dispatch({ type: "case", caseId });
    dispatch({ type: "generation", generation: candidate.generation });
    dispatch({ type: "candidate", id: candidateId });
  }, [cases, dispatch]);
  return { cases, current, state, event, reduced, dispatch, locateCandidate, holdoutVisible: event.stage >= 6 };
}

export type CasePlayback = ReturnType<typeof useCasePlayback>;
