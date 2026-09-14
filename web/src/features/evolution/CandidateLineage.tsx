import { ArrowRight, GitBranch, ShieldCheck, X } from "lucide-react";
import type { Candidate } from "./types";
import type { CasePlayback } from "./useCasePlayback";
import { tabKey } from "./CaseControls";

export function CandidateLineage({ playback }: { playback: CasePlayback }) {
  const { current, state, dispatch } = playback;
  const generation = state.generation ? current.generations[state.generation - 1] : null;
  const seats = generation?.after ?? current.generations[0].before;
  const visible = generation ? generation.attemptedIds.map(id => current.byId[id]) : current.roots;
  const selected = current.byId[state.selectedCandidateId];
  const status = (candidate: Candidate) => !candidate.qualification.eligible ? "淘汰" : candidate.id === current.champion?.id ? "公共冠军 · Elite" : seats.eliteId === candidate.id ? "入选 Elite" : seats.diversityId === candidate.id ? "入选 Diversity" : "合格 · 累计池保留";
  return <div className="candidate-lineage case-surface" id="candidate-lineage">
    <div className="module-title"><span>02 / 变异与谱系</span><GitBranch size={18} aria-hidden="true" /></div>
    <div className="lineage-tabs compact-tabs" role="tablist" aria-label="变异代际">
      {Array.from({ length: current.stats.generations + 1 }, (_, index) => <button type="button" role="tab" key={index} aria-selected={state.generation === index} aria-controls="generation-panel" id={`generation-tab-${index}`} tabIndex={state.generation === index ? 0 : -1} onClick={() => dispatch({ type: "generation", generation: index })} onKeyDown={event => tabKey(event,index,current.stats.generations+1,next => dispatch({type:"generation",generation:next}))}>G{index}<small>{index === 0 ? "冻结根" : index === current.stats.generations ? "最终代" : "变异"}</small></button>)}
    </div>
    <div className="lineage-counts"><span>尝试 <b>{current.stats.attempts}</b></span><span>有效 <b>{current.stats.valid}</b></span><span>曾入选 <b>{current.stats.selected}</b></span><span>淘汰 <b>{current.stats.rejected}</b></span></div>
    <div id="generation-panel" role="tabpanel" aria-labelledby={`generation-tab-${state.generation}`}>
      <p className="population-seats"><ShieldCheck size={14} /><span>Anchor 固定 B0 <i /> Elite {seats.eliteId} <i /> Diversity {seats.diversityId ?? "空缺"}</span></p>
      <div className="candidate-cards">{visible.map(candidate => <button type="button" key={candidate.id} className={`candidate-card${selected.id === candidate.id ? " is-selected" : ""}${!candidate.qualification.eligible ? " is-rejected" : ""}`} aria-pressed={selected.id === candidate.id} onClick={() => dispatch({ type: "candidate", id: candidate.id })}>
        <span className="candidate-top"><span>{candidate.lane === "root" ? "FROZEN ROOT" : candidate.lane.toUpperCase()}</span><b>{status(candidate)}</b></span>
        <span className="candidate-identity">{candidate.parentId && <><small>{candidate.parentId}</small><ArrowRight size={15} /></>}<strong>{candidate.id}</strong><small className="candidate-train">train {candidate.trainScore}</small></span>
        <span className="candidate-name">{candidate.title}</span>
        <span className="candidate-reason">{candidate.rejectionReason ? <><X size={13} />{candidate.rejectionReason}</> : candidate.selectionReason}</span>
      </button>)}</div>
      <p className="train-note">train 反馈用于累计池重选；公共分数与独立复核在下方单独比较，不拼接成增长曲线。</p>
    </div>
    <details className="candidate-diff inline-disclosure" key={selected.id} open>
      <summary>{selected.id} 的变异记录 <span>{selected.diff.length} 处编辑</span></summary>
      {selected.diff.length ? selected.diff.map((edit,index) => <div className="mutation-edit" key={index}><p><b>0{index+1}</b>{edit.reason}</p><div className="patch-remove"><span>−</span><p>{edit.target}</p></div><div className="patch-add"><span>+</span><p>{edit.replacement}</p></div></div>) : <p className="root-detail">冻结根不随演化改写。{selected.id === "B0" ? "保留原始 Skill，始终作为 Anchor。" : "保留独立策略的首轮候选，与 B0 分别比较。"}</p>}
      <p className="candidate-verdict">{selected.rejectionReason ? `不合格：${selected.rejectionReason}。` : "资格检查通过。"}{selected.selectionReason}</p>
      <code className="candidate-hash">内容 SHA-256 · {selected.skillHash.slice(0,16)}</code>
    </details>
  </div>;
}
