import { ArrowUpRight, Check } from "lucide-react";
import { score, formatScore, formatDelta } from "./caseEngine";
import { CaseTabs, DetailHeading } from "./CaseControls";
import { CandidateLineage } from "./CandidateLineage";
import { InputOutput, SkillDelivery } from "./SkillComparison";
import { EvolutionStory } from './EvolutionStory';
import type { CasePlayback } from "./useCasePlayback";

export function EvolutionCases({ playback }: { playback: CasePlayback }) {
  const { current, state } = playback;
  const deliverable = current.resolution.finalCandidateId !== null;
  const startScore = score(current.starting.publicScorecard!);
  const finalScore = score(current.final.publicScorecard!);
  const directDelta = Math.round((finalScore-score(current.direct.publicScorecard!))*100)/100;
  return <section className="content-section content-section--detail evolution-evidence" id="evidence">
    <DetailHeading index="02" label="Evolution cases" title="从一个起点，到一个值得保留的新版本">选择一个任务，查看每次变异如何改变输出，以及最终版本为什么胜出。</DetailHeading>
    <CaseTabs playback={playback} />
    <div id="evolution-case-panel" role="tabpanel" aria-labelledby={`evolution-tab-${state.caseId}`}>
      <div className="case-overview"><div><span className="micro-label">CASE {state.caseId} · {current.definition.routeName}</span><h3>{current.definition.title.split(/(?<=，)/).map(phrase=><span key={phrase}>{phrase}</span>)}</h3><p>{current.definition.goal}</p></div><div className="case-outcome"><div className="outcome-meta"><small>{current.stats.generations} 代变异 · {deliverable ? '1 份最终文件' : '未形成交付'}</small><span className="decision-pill">{deliverable && <Check size={14} />}{current.resolution.outcome === 'ADOPT' ? '已采用' : deliverable ? '保留' : '停止交付'} {deliverable ? current.final.id : ''}</span></div>{deliverable ? <><strong>{formatScore(startScore)} <span>→</span> {formatScore(finalScore)}</strong><small>公共分数 · {current.starting.id} → {current.final.id}</small><p><ArrowUpRight size={15} />较起点 {formatDelta(finalScore-startScore)} 分 <i />较 Direct {formatDelta(directDelta)} 分</p></> : <p>{current.resolution.reasons.join(' ')}</p>}</div></div>
      <InputOutput current={current} />
      <EvolutionStory playback={playback} />
      <details className="all-candidates inline-disclosure" id="all-candidates" key={`records-${state.caseId}`}>
        <summary>查看全部候选与逐代记录 <span>{current.stats.generations} 代 · {current.stats.attempts} 个尝试 · {current.stats.rejected} 个淘汰</span></summary>
        <CandidateLineage playback={playback} key={state.caseId} />
      </details>
      <SkillDelivery current={current} key={state.caseId} />
    </div>
  </section>;
}
