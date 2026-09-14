import { Check, X } from "lucide-react";
import { DIMENSIONS, WEIGHTS, comparisonScores, score, formatScore, formatDelta } from "./caseEngine";
import { DetailHeading, tabKey } from "./CaseControls";
import { revealSection } from './navigation';
import type { CasePlayback } from "./useCasePlayback";

export function EvaluationComparison({ playback }: { playback: CasePlayback }) {
  const { current, state, dispatch, holdoutVisible } = playback;
  const tab = state.evaluationTab;
  const holdout = tab === "holdout";
  const values = comparisonScores(current, tab);
  const bound = !holdout || values.every(Boolean);
  const adopted = current.resolution.outcome === "ADOPT";
  const rejected = current.candidates.find(candidate => !candidate.qualification.eligible)!;
  const available = !holdout || (holdoutVisible && bound);
  const dimensionDelta = (index: number) => values[0] && values[1] ? formatDelta(values[1][index] - values[0][index]) : "—";
  return <section className="content-section content-section--detail evaluation-comparison" id="evaluation">
    <DetailHeading index="03" label="Selection rationale" title={adopted ? "为什么采用这个子代" : current.resolution.outcome === 'RETAIN' ? "为什么保留起点" : '为什么停止交付'}>{current.definition.label} · 用具体行为解释分差，再看独立复核是否保持改善。</DetailHeading>
    <div className="evaluation-toolbar"><div className="compact-tabs" role="tablist" aria-label="评测阶段">{["public","holdout"].map((value,index) => <button type="button" role="tab" aria-selected={tab===value} aria-controls="evaluation-panel" id={`evaluation-tab-${value}`} tabIndex={tab===value?0:-1} key={value} onClick={()=>dispatch({type:"evaluation",tab:value as "public"|"holdout"})} onKeyDown={event=>tabKey(event,index,2,next=>dispatch({type:"evaluation",tab:next?"holdout":"public"}))}>{index?"独立复核":"公共评测"}</button>)}</div><p>五维权重 <b>{WEIGHTS.map(value=>value*100).join(" / ")}</b></p></div>
    <div id="evaluation-panel" role="tabpanel" aria-labelledby={`evaluation-tab-${tab}`}>
      <p className="evaluation-context">{holdout ? current.definition.holdout.task : "固定公共任务集上的版本比较。train 反馈用于变异与累计池重选，不计入本表。"}</p>
      {!available ? <div className="review-pending case-surface"><h3>{bound ? "先固定比较版本，再进入独立复核" : "当前版本没有匹配的独立复核"}</h3><p>{bound ? `当前查看「${playback.event.title}」。复核结果不会用于前面的变异或公共选择。` : "版本 ID 或内容 hash 不一致时，已有复核分数不可沿用。当前保留起点，不展示未匹配的三版本成绩。"}</p>{bound && <button className="case-button" type="button" onClick={()=>dispatch({type:"stage",stage:6})}>查看独立复核阶段</button>}</div> : <>
        <div className="score-table-wrap" tabIndex={0} role="region" aria-label="五维版本比较，可横向滚动"><table className="comparison-table"><thead><tr><th scope="col">Skill 评测维度</th><th scope="col"><small>Starting Reference</small>{current.starting.id}</th><th scope="col" className="adaptive-column"><small>Adaptive</small>{current.champion?.id ?? "无新冠军"}</th><th scope="col"><small>Direct</small>独立一次改写</th><th scope="col">较起点</th><th scope="col" className="comparison-reason">差异依据</th></tr></thead><tbody>
          {DIMENSIONS.map((dimension,index)=><tr key={dimension}><th scope="row">{dimension}</th>{values.map((dimensions,column)=><td className={column===1?"adaptive-column":""} key={column}>{dimensions ? formatScore(dimensions[index]) : "—"}</td>)}<td className="delta-value">{dimensionDelta(index)}</td><td className="comparison-reason">{adopted ? current.definition.dimensionReasons[index] : current.publicDecision.reason}</td></tr>)}
        </tbody><tfoot><tr><th scope="row">加权总分</th>{values.map((dimensions,index)=><td key={index} className={index===1?"adaptive-column":""}>{dimensions ? formatScore(score(dimensions)) : "—"}</td>)}<td>{values[0] && values[1] ? formatDelta(score(values[1])-score(values[0])) : "—"}</td><td className="comparison-reason">{holdout?"只复核已固定的三份版本，不返回训练或公共选择。":"资格通过、不同内容 hash、五维达标、公共增益 ≥ 3 分。"}</td></tr></tfoot></table></div>
        <p className="table-footnote">单位：分。总分 = 五维 × 35% / 25% / 20% / 10% / 10%，先计算后展示，保留两位小数。</p>
      </>}
    </div>
    <div className="evaluation-bottom"><div className="case-surface critical-checks"><div className="module-title"><span>关键检查</span><span>{current.definition.id} / 保留与改进</span></div>{adopted ? current.definition.criticalChecks.map(check=><div className="critical-check" key={check.label}><Check size={16}/><div><h4>{check.label}</h4><p>{check.detail}</p></div></div>) : <><p>{current.resolution.reasons.join(" ")}</p>{current.final.qualification.checks.map(check=><div className="critical-check" key={check.id}>{check.passed ? <Check size={16}/> : <X size={16}/>}<div><h4>{check.label}</h4><p>保留版本 {current.final.id} · {check.passed ? "通过" : "未通过"}</p></div></div>)}</>}</div>
      <div className="case-surface rejection-example"><div className="module-title"><span>一个被淘汰的版本</span><X size={16}/></div><h3>{rejected.id} <small>G{rejected.generation} · {rejected.lane}</small></h3><p className="rejection-title">{rejected.rejectionReason}</p><blockquote>{rejected.diff[0].replacement}</blockquote><p>{rejected.selectionReason}</p><button type="button" className="text-control" onClick={()=>{playback.locateCandidate(current.definition.id,rejected.id);revealSection('candidate-lineage', playback.reduced);}}>查看这个子代的完整改动 →</button></div></div>
    {current.definition.reviewDimensions && <div className="review-dimensions"><b>本案中的两套五维，不是同一套指标。</b><p>上表评价 Skill。客户方案本身另按「{current.definition.reviewDimensions.join(" / ")}」审核；采用 {current.final.id} 不代表客户方案获批。</p></div>}
    <details className="inline-disclosure public-pool"><summary>查看其余候选的公共比较 <span>{current.stats.valid} 个合格子代</span></summary><div className="public-pool-list">{current.candidates.filter(candidate=>candidate.lane!=="root").map(candidate=><article key={candidate.id}><b>{candidate.id}</b><strong>{candidate.publicScorecard?`${formatScore(score(candidate.publicScorecard))} 分`:"不具备资格"}</strong><p>{candidate.publicScorecard?candidate.selectionReason:candidate.rejectionReason}</p></article>)}</div></details>
    <p className="computed-decision"><Check size={20} aria-hidden="true" /><span>{current.resolution.reasons.join(" ")}</span></p>
  </section>;
}
