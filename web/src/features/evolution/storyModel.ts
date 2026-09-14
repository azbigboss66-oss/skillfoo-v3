import type { EvolutionCase, MutationEdit } from './types';

// Exact complete sentences from an actual edit, never invented intermediate model output.
export function ruleExcerpt(text: string) {
  return (text.match(/[^。！？]+[。！？]?/gu) ?? [text]).slice(0, 2).join('');
}

export function evolutionStory(current: EvolutionCase) {
  const adopted = current.resolution.outcome === 'ADOPT';
  const path = current.ancestry.map(id => current.byId[id]);
  const steps = path.filter(candidate => candidate.parentId !== null).map(candidate => {
    const generation = current.generations.find(item => item.number === candidate.generation);
    if (!generation?.attemptedIds.includes(candidate.id)) throw new Error(`Missing generation for ${candidate.id}`);
    const parent = current.byId[candidate.parentId!];
    if (!parent) throw new Error(`Missing parent for ${candidate.id}`);
    return { candidate, parent, generation, edits: candidate.mutationEdits.map((edit: MutationEdit) => ({
      reason: edit.reason, before: ruleExcerpt(edit.target), after: ruleExcerpt(edit.replacement),
    })), exploration: candidate.lane === 'diversify' };
  });
  return {
    adopted, outcome: current.resolution.outcome,
    title: adopted ? '为什么这一版胜出' : current.resolution.outcome === 'RETAIN' ? '为什么这次保留起点' : '为什么这次未能交付',
    root: path[0], steps,
    rejected: current.candidates.filter(candidate => !candidate.qualification.eligible && candidate.parentId !== null),
    publicChampion: current.champion, final: current.resolution.finalCandidateId ? current.final : null,
    reasons: current.resolution.reasons,
  };
}
