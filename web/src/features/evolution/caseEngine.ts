import type { Candidate, CaseDefinition, CaseId, EvolutionCase, HoldoutResult, MutationEdit, PlaybackAction, PlaybackState, Population, PublicDecision, Qualification, Resolution, Scores, StageEvent, TextCheck } from "./types";

export const DIMENSIONS = ["任务正确性", "证据边界", "能力边界", "输出结构", "可执行性"] as const;
export const WEIGHTS = [0.35, 0.25, 0.20, 0.10, 0.10] as const;
export const STAGE_NAMES = ["输入", "双重确认", "B0 / S0", "自适应种群", "公共选择", "Direct 对照", "Sealed Holdout", "最终决策"] as const;
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
export const formatScore = (value: number) => value.toFixed(2);
export const formatDelta = (value: number) => `${value >= 0 ? "+" : ""}${formatScore(value)}`;

export function score(dimensions: Scores): number {
  if (dimensions.length !== 5 || dimensions.some(value => !Number.isFinite(value) || value < 0 || value > 100)) throw new Error("五维分数必须为 0–100 的有限数值");
  return round(dimensions.reduce((sum, value, index) => sum + value * WEIGHTS[index], 0));
}

export async function contentHash(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

export function applyEdits(parentContent: string, edits: MutationEdit[]): string {
  if (edits.length === 0) throw new Error("变异不能包含空补丁");
  return edits.reduce((content, edit) => {
    if (!edit.target || edit.target === edit.replacement) throw new Error("编辑目标为空或没有实际变化");
    const at = content.indexOf(edit.target);
    if (at < 0 || content.indexOf(edit.target, at + edit.target.length) >= 0) throw new Error(`编辑目标必须存在且唯一：${edit.target.slice(0, 50)}`);
    return content.slice(0, at) + edit.replacement + content.slice(at + edit.target.length);
  }, parentContent);
}

export async function materializeCandidate(parentContent: string, edits: MutationEdit[]) {
  const content = applyEdits(parentContent, edits);
  if (content === parentContent) throw new Error("子代内容与父版本一致");
  return { content, diff: edits.map(edit => ({ ...edit })), hash: await contentHash(content) };
}

export function qualify(content: string, rules: TextCheck[]): Qualification {
  const headers = ["适用任务", "输入要求", "执行步骤", "输出合同", "异常与缺失信息处理", "需要保护的行为"];
  const checks = [{ id: "complete-skill", label: "完整 Skill 结构与元数据", passed: /^---\nname: [\w-]+\ndescription: .+\n---/.test(content) && headers.every(heading => content.includes(`## ${heading}\n`)) }];
  for (const rule of rules) {
    const section = rule.section ? content.split(`## ${rule.section}\n`)[1]?.split("\n## ")[0] ?? "" : content;
    checks.push({ id: rule.id, label: rule.label, passed: (!rule.required || section.includes(rule.required)) && (!rule.forbidden || !section.includes(rule.forbidden)) });
  }
  return { eligible: checks.every(check => check.passed), checks };
}

export function selectPopulation(pool: Candidate[]): Population {
  const anchor = pool.find(candidate => candidate.id === "B0");
  if (!anchor) throw new Error("累计池缺少冻结 Anchor B0");
  const valid = pool.filter(candidate => candidate.qualification.eligible && candidate.lane !== "direct");
  const ranked = [...valid].sort((a, b) => b.trainScore - a.trainScore || a.generation - b.generation || a.id.localeCompare(b.id));
  const elite = ranked[0];
  if (!elite) throw new Error("累计池没有合格候选");
  const diversity = ranked.find(candidate => candidate.id !== elite.id && candidate.strategy !== elite.strategy);
  return { anchorId: anchor.id, eliteId: elite.id, diversityId: diversity?.id ?? null };
}

export function selectPublicCandidate(roots: Candidate[], challengers: Candidate[]): PublicDecision {
  const qualifiedRoots = roots.filter(root => root.qualification.eligible && root.publicScorecard);
  // A tied starting reference always stays B0, independent of array order.
  qualifiedRoots.sort((a, b) => score(b.publicScorecard!) - score(a.publicScorecard!) || (a.id === "B0" ? -1 : 1));
  const starting = qualifiedRoots[0];
  if (!starting) throw new Error("没有合格的 B0 / S0 比较基准");
  const eligible = challengers.filter(candidate => candidate.lane !== "root" && candidate.lane !== "direct" && candidate.qualification.eligible && candidate.publicScorecard && candidate.skillHash !== starting.skillHash && candidate.publicScorecard.every(value => value >= 60) && [1, 2].every(index => candidate.publicScorecard![index] >= starting.publicScorecard![index]));
  eligible.sort((a, b) => score(b.publicScorecard!) - score(a.publicScorecard!) || a.id.localeCompare(b.id));
  const best = eligible[0];
  const delta = best ? round(score(best.publicScorecard!) - score(starting.publicScorecard!)) : 0;
  if (!best || delta < 3) return { startingReferenceId: starting.id, championId: null, delta, reason: `保留 ${starting.id}：没有通过资格且公共增益至少 3 分的新子代。` };
  return { startingReferenceId: starting.id, championId: best.id, delta, reason: `${best.id} 资格检查通过，五维均达标，公共分数高于 ${starting.id} ${formatScore(delta)} 分。` };
}

export function resolveCase(publicDecision: PublicDecision, direct: Candidate, holdout: HoldoutResult | null, candidates: Candidate[]): Resolution {
  const starting = candidates.find(candidate => candidate.id === publicDecision.startingReferenceId);
  const champion = candidates.find(candidate => candidate.id === publicDecision.championId);
  if (!starting?.qualification.eligible) return { outcome: "FAILED", finalCandidateId: null, reasons: ["起点资格无法确认，停止交付。"] };
  const retain = (reason: string): Resolution => ({ outcome: "RETAIN", finalCandidateId: starting.id, reasons: [reason] });
  if (!champion || publicDecision.delta < 3 || !champion.qualification.eligible || champion.skillHash === starting.skillHash || !champion.publicScorecard?.every(value => value >= 60)) return retain("新子代未满足公共选择条件，保留起点。");
  if (!direct.qualification.eligible || !direct.publicScorecard || score(champion.publicScorecard) <= score(direct.publicScorecard)) return retain("新子代未领先独立 Direct 对照，保留起点。");
  if (!holdout || holdout.starting.candidateId !== starting.id || holdout.adaptive.candidateId !== champion.id || holdout.direct.candidateId !== direct.id || holdout.starting.skillHash !== starting.skillHash || holdout.adaptive.skillHash !== champion.skillHash || holdout.direct.skillHash !== direct.skillHash) return retain("三份固定版本的独立复核尚未完成或内容身份不一致。");
  if (!Object.values(holdout).every(result => result.passed) || !holdout.adaptive.dimensions.every(value => value >= 60)) return retain("独立复核存在资格或关键检查未通过，保留起点。");
  if (score(holdout.adaptive.dimensions) <= Math.max(score(holdout.starting.dimensions), score(holdout.direct.dimensions))) return retain("独立复核未保持领先，保留起点。");
  return { outcome: "ADOPT", finalCandidateId: champion.id, reasons: [`采用 ${champion.id}：公共分数高于 ${starting.id} ${formatScore(publicDecision.delta)} 分，关键要求通过，独立复核仍领先，且改进已落实到最终 SKILL.md。`] };
}

export function ancestryOf(id: string, byId: Record<string, Candidate>): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  let current: string | null = id;
  while (current) {
    if (visited.has(current)) throw new Error("候选父子关系形成环");
    visited.add(current);
    const candidate: Candidate | undefined = byId[current];
    if (!candidate) throw new Error(`父版本不存在：${current}`);
    result.unshift(current);
    current = candidate.parentId;
  }
  return result;
}

export function createEvents(generations: number): StageEvent[] {
  const events = STAGE_NAMES.flatMap((title, stage) => stage === 3
    ? Array.from({ length: generations }, (_, index) => ({ id: `generation-${index + 1}`, stage, generation: index + 1, title: `G${index + 1} · 变异与重选`, duration: 2500 }))
    : [{ id: `stage-${stage}`, stage, generation: stage < 3 ? 0 : generations, title, duration: stage === 7 ? 0 : 2200 }]);
  return events;
}

export async function buildCase(definition: CaseDefinition): Promise<EvolutionCase> {
  const byId: Record<string, Candidate> = {};
  const baseFields = { caseId: definition.id, generation: 0, parentId: null, lane: "root" as const, mutationEdits: [], diff: [], selectionReason: "冻结的 generation-zero 根；不被子代覆盖。" };
  for (const id of ["B0", "S0"] as const) {
    const material = id === "B0" ? { content: definition.baselineContent, hash: await contentHash(definition.baselineContent), diff: [] } : await materializeCandidate(definition.baselineContent, definition.scaffoldEdits);
    const qualification = qualify(material.content, definition.checks);
    byId[id] = { ...baseFields, ...definition.roots[id], trainScore: score(definition.roots[id].trainScorecard), id, title: id === "B0" ? "原始 Skill · 冻结 Anchor" : "首轮候选 · 独立策略", skillContent: material.content, skillHash: material.hash, qualification, rejectionReason: qualification.eligible ? null : qualification.checks.filter(check => !check.passed).map(check => check.label).join("；") };
    score(byId[id].publicScorecard!);
  }
  const roots = [byId.B0, byId.S0];
  const pool = [...roots];
  const generations = [];
  const count = Math.max(...definition.candidates.map(candidate => candidate.generation));
  for (let generation = 1; generation <= count; generation++) {
    const before = selectPopulation(pool);
    const attempts = definition.candidates.filter(candidate => candidate.generation === generation);
    if (attempts.length === 0 || attempts.length > 2 || new Set(attempts.map(candidate => candidate.lane)).size !== attempts.length) throw new Error("每代至多一个 exploit 与一个 diversify，代际必须连续");
    for (const spec of attempts) {
      if (byId[spec.id]) throw new Error(`重复候选 ID：${spec.id}`);
      const parent = byId[spec.parentId];
      if (!parent || parent.generation >= generation) throw new Error(`无效父版本：${spec.id}`);
      const expectedParent = spec.lane === "exploit" ? before.eliteId : before.diversityId;
      if (parent.id !== expectedParent) throw new Error(`${spec.id} 的父版本不符合上一代累计池席位`);
      const trainScore = score(spec.trainScorecard);
      const material = await materializeCandidate(parent.skillContent, spec.mutationEdits);
      const qualification = qualify(material.content, definition.checks);
      if (qualification.eligible && !spec.publicScorecard) throw new Error(`合格子代缺少公共比较：${spec.id}`);
      if (!qualification.eligible && spec.publicScorecard) throw new Error(`不合格子代不能进入公共比较：${spec.id}`);
      if (spec.publicScorecard) score(spec.publicScorecard);
      const candidate: Candidate = { ...spec, trainScore, caseId: definition.id, skillContent: material.content, skillHash: material.hash, diff: material.diff, qualification, rejectionReason: qualification.eligible ? null : qualification.checks.filter(check => !check.passed).map(check => check.label).join("；") };
      byId[candidate.id] = candidate;
      pool.push(candidate);
    }
    generations.push({ number: generation, before, after: selectPopulation(pool), attemptedIds: attempts.map(candidate => candidate.id) });
  }
  pool.forEach(candidate => ancestryOf(candidate.id, byId));
  // Direct is materialized only from a frozen root. No candidate pool or holdout enters its edits.
  const directParent = roots.find(root => root.id === definition.direct.rootId)!;
  const directMaterial = await materializeCandidate(directParent.skillContent, definition.direct.edits);
  const directQualification = qualify(directMaterial.content, definition.checks);
  const direct: Candidate = { ...baseFields, id: `${definition.id}-Direct`, parentId: directParent.id, lane: "direct", strategy: "one-shot", title: "独立一次改写", trainScore: 0, skillContent: directMaterial.content, skillHash: directMaterial.hash, mutationEdits: definition.direct.edits, diff: directMaterial.diff, qualification: directQualification, rejectionReason: null, publicScorecard: definition.direct.publicScorecard };
  score(direct.publicScorecard!);
  const publicDecision = selectPublicCandidate(roots, pool.filter(candidate => candidate.lane !== "root"));
  const starting = byId[publicDecision.startingReferenceId];
  const champion = publicDecision.championId ? byId[publicDecision.championId] : null;
  // Freeze all three identities before reading independent review scores. These never feed train/public selection.
  const bindReview = (role: "starting" | "adaptive" | "direct", candidate: Candidate | null) => {
    const identity = definition.holdout.identities[role];
    return { ...identity, dimensions: definition.holdout[role], passed: !!candidate?.qualification.eligible && identity.candidateId === candidate.id && identity.skillHash === candidate.skillHash };
  };
  const holdout: HoldoutResult = { starting: bindReview("starting", starting), adaptive: bindReview("adaptive", champion), direct: bindReview("direct", direct) };
  Object.values(holdout).forEach(result => score(result.dimensions));
  const resolution = resolveCase(publicDecision, direct, holdout, pool);
  const final = byId[resolution.finalCandidateId ?? starting.id];
  const selected = new Set(generations.flatMap(g => [g.after.eliteId, g.after.diversityId]).filter(id => id && !["B0", "S0"].includes(id)));
  const children = pool.filter(candidate => candidate.lane !== "root");
  return { definition, candidates: pool, byId, roots, direct, generations, publicDecision, holdout, resolution, starting, champion, final, ancestry: ancestryOf(final.id, byId), events: createEvents(count), stats: { attempts: children.length, valid: children.filter(candidate => candidate.qualification.eligible).length, rejected: children.filter(candidate => !candidate.qualification.eligible).length, selected: selected.size, generations: count } };
}

export const buildCases = (definitions: CaseDefinition[]) => Promise.all(definitions.map(buildCase));

// Review numbers belong to content identities, never to whichever candidate currently occupies a role.
export function comparisonScores(current: EvolutionCase, phase: "public" | "holdout"): (Scores | null)[] {
  const candidates = [current.starting, current.champion, current.direct];
  if (phase === "public") return candidates.map(candidate => candidate?.publicScorecard ?? null);
  return (["starting", "adaptive", "direct"] as const).map((role, index) => {
    const candidate = candidates[index], review = current.holdout[role];
    return candidate && review.candidateId === candidate.id && review.skillHash === candidate.skillHash ? review.dimensions : null;
  });
}

export function finalOutput(current: EvolutionCase): string {
  return current.resolution.outcome === "ADOPT" ? current.definition.after : current.definition.before;
}

export function initialPlayback(current: EvolutionCase): PlaybackState {
  return { caseId: current.definition.id, eventIndex: current.events.length - 1, playing: false, generation: current.stats.generations, selectedCandidateId: current.final.id, evaluationTab: "public" };
}

export function reducePlayback(state: PlaybackState, action: PlaybackAction, cases: EvolutionCase[]): PlaybackState {
  const current = cases.find(item => item.definition.id === state.caseId)!;
  const at = (index: number, playing = false) => {
    const nextIndex = Math.max(0, Math.min(current.events.length - 1, index));
    const event = current.events[nextIndex];
    const seat = event.generation ? current.generations[event.generation - 1].after.eliteId : current.generations[0].before.eliteId;
    return { ...state, eventIndex: nextIndex, generation: event.generation, playing: playing && nextIndex < current.events.length - 1, selectedCandidateId: seat, evaluationTab: event.stage >= 6 ? "holdout" as const : "public" as const };
  };
  switch (action.type) {
    case "case": return initialPlayback(cases.find(item => item.definition.id === action.caseId)!);
    case "start": return at(0, !action.reduced);
    case "pause": return { ...state, playing: false };
    case "resume": return { ...state, playing: !action.reduced && state.eventIndex < current.events.length - 1 };
    case "step":
      if (action.automatic && (action.caseId !== state.caseId || action.expectedIndex !== state.eventIndex || !state.playing)) return state;
      return at(state.eventIndex + action.delta, !!action.automatic);
    case "stage": {
      if (!Number.isInteger(action.stage) || action.stage < 0 || action.stage > 7) return state;
      const generation = current.events[state.eventIndex].stage === 3 ? Math.max(1, state.generation) : 1;
      return at(current.events.findIndex(event => event.stage === action.stage && (event.stage !== 3 || event.generation === generation)));
    }
    case "generation": {
      if (!Number.isInteger(action.generation) || action.generation < 0 || action.generation > current.stats.generations) return state;
      if (action.generation === 0) return at(current.events.findIndex(event => event.stage === 2));
      return at(current.events.findIndex(event => event.stage === 3 && event.generation === action.generation));
    }
    case "candidate": return current.byId[action.id] ? { ...state, playing: false, selectedCandidateId: action.id } : state;
    case "evaluation": return { ...state, evaluationTab: action.tab };
    case "final": return initialPlayback(current);
  }
}

export function stageDetail(current: EvolutionCase, state: PlaybackState) {
  const d = current.definition;
  const event = current.events[state.eventIndex];
  const generation = current.generations[Math.max(0, state.generation - 1)];
  const attemptText = generation.attemptedIds.map(id => { const c = current.byId[id]; return `${c.parentId} → ${id}（${c.lane}）：${c.title}；${c.rejectionReason ? `淘汰：${c.rejectionReason}` : c.selectionReason}`; }).join(" ");
  const reviewBound = comparisonScores(current, "holdout").every(Boolean);
  const details = [
    { summary: d.goal, input: d.inputs.map(input => `${input.id}：${input.title}`).join("；"), action: `确认使用场景：${d.application}`, output: "输入资料与目标固定，references / 附件保持只读。" },
    { summary: "目标要求与评测要求分别确认，再冻结后续比较使用的规则。", input: d.goal, action: d.criticalChecks.map(check => check.label).join("；"), output: `本案要求：${d.protectedBehavior}` },
    { summary: `B0 为 Anchor；G0 的 Elite 是 ${current.generations[0].before.eliteId}，Diversity 是 ${current.generations[0].before.diversityId}。`, input: `B0 ${formatScore(score(current.byId.B0.publicScorecard!))} / S0 ${formatScore(score(current.byId.S0.publicScorecard!))}（公共分数）`, action: "两个根版本各自保留完整文本和内容 hash，席位按 train 反馈重选。", output: `冻结 B0：${current.byId.B0.skillHash.slice(0, 12)}；S0：${current.byId.S0.skillHash.slice(0, 12)}` },
    { summary: `G${generation.number} / G${current.stats.generations} · ${d.routeName}`, input: `Anchor B0 · Elite ${generation.before.eliteId} · Diversity ${generation.before.diversityId}`, action: attemptText, output: `重选：Elite ${generation.after.eliteId} · Diversity ${generation.after.diversityId}。本案尝试 ${current.stats.attempts} 个子代；图中 33 条线是族群结构，不是子代计数。` },
    { summary: current.publicDecision.reason, input: `Starting Reference ${current.starting.id}；${current.stats.valid} 个合格子代进入公共比较。`, action: "先资格与关键要求，再比较五维总分；新内容 hash 必须不同，增益至少 3 分。", output: `${current.champion?.id ?? current.starting.id} · ${formatScore(score((current.champion ?? current.starting).publicScorecard!))} 分；冻结比较版本。` },
    { summary: d.direct.output, input: `Direct 仅从冻结 ${d.direct.rootId} 独立派生，不读取候选池。`, action: d.direct.limitation, output: `Direct 公共分数 ${formatScore(score(current.direct.publicScorecard!))}，只作对照，不自动交付。` },
    { summary: d.holdout.task, input: current.champion ? `${current.starting.id} / ${current.champion.id} / ${current.direct.id}；按版本 ID 与内容 hash 匹配复核。` : "没有满足公共增益要求的新冠军，不启动三版本复核。", action: reviewBound ? `独立复核：起点 ${formatScore(score(current.holdout.starting.dimensions))} · Adaptive ${formatScore(score(current.holdout.adaptive.dimensions))} · Direct ${formatScore(score(current.holdout.direct.dimensions))}` : "已有复核与当前比较版本不匹配，不能沿用其分数；保留起点。", output: "复核只检验已选版本，不反馈到前面的变异与公共选择。" },
    { summary: current.resolution.reasons.join(" "), input: `最终文件祖先链：${current.ancestry.join(" → ")}`, action: d.reviewedObjectDecision ?? "交付完整 SKILL.md，保留资料输入、变异记录和版本对比。", output: `${current.final.id} · SHA-256 ${current.final.skillHash.slice(0, 16)} · ${current.resolution.outcome}` },
  ];
  return { ...details[event.stage], title: STAGE_NAMES[event.stage], index: String(event.stage + 1).padStart(2, "0") };
}

export function lineDiff(before: string, after: string): { kind: "same" | "remove" | "add"; text: string }[] {
  const a = before.split("\n"), b = after.split("\n");
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows: { kind: "same" | "remove" | "add"; text: string }[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { rows.push({ kind: "same", text: a[i++] }); j++; }
    else if (j < b.length && (i === a.length || dp[i][j + 1] > dp[i + 1][j])) rows.push({ kind: "add", text: b[j++] });
    else rows.push({ kind: "remove", text: a[i++] });
  }
  return rows;
}

export function findCase(cases: EvolutionCase[], id: CaseId) { return cases.find(item => item.definition.id === id)!; }
