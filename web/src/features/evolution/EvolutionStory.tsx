import { ArrowRight, GitBranch, X } from 'lucide-react';
import { evolutionStory } from './storyModel';
import { revealSection } from './navigation';
import type { CasePlayback } from './useCasePlayback';

export function EvolutionStory({ playback }: { playback: CasePlayback }) {
  const { current } = playback;
  const story = evolutionStory(current);
  const inspect = (id: string) => {
    playback.locateCandidate(current.definition.id, id);
    revealSection('candidate-lineage', playback.reduced);
  };
  return <section className="evolution-story" aria-labelledby="story-heading" data-outcome={story.outcome}>
    <div className="story-heading"><span className="micro-label">02 / 版本怎样改变</span><h3 id="story-heading">{story.title}</h3><p>{story.adopted ? '沿最终版本的真实父子关系阅读；每处变化都来自 SKILL.md 的实际修改。' : story.reasons.join(' ')}</p></div>
    <ol className="story-timeline">
      <li className="story-root" data-candidate={story.root.id}><div className="story-station">G0</div><div className="story-copy"><span className="micro-label">冻结根 · {story.root.id}</span><h4>{story.root.title}</h4><p>{story.root.selectionReason}</p></div></li>
      {story.steps.map(step => <li key={step.candidate.id} data-candidate={step.candidate.id} className={step.exploration ? 'story-step story-step--exploration' : 'story-step'}>
        <div className="story-station">G{step.candidate.generation}</div>
        <div className="story-copy">
          <div className="story-identity"><span>{step.parent.id} <ArrowRight size={15} /> {step.candidate.id}</span><span>{step.exploration ? <><GitBranch size={16} />探索突破 · diversify</> : '沿有效策略精修 · exploit'}</span></div>
          <h4>{step.candidate.title}</h4>
          {step.edits.slice(0, 1).map((edit, index) => <div className="story-edit" key={index}>
            <p className="story-edit-reason"><b>关键修改</b>{edit.reason}</p>
            <div className="story-rule-pair"><div><span>修改前 · 规则节选</span><blockquote>{edit.before}</blockquote></div><div><span>修改后 · 规则节选</span><blockquote>{edit.after}</blockquote></div></div>
          </div>)}
          <p className="story-selection"><b>为什么保留</b>{step.candidate.selectionReason}</p>
          <button type="button" className="text-control" onClick={() => inspect(step.candidate.id)}>查看 {step.candidate.id} 的完整 {step.candidate.mutationEdits.length} 处修改 <ArrowRight size={16} /></button>
        </div>
      </li>)}
      <li className="story-result"><div className="story-station">{story.outcome === 'ADOPT' ? '采用' : story.outcome === 'RETAIN' ? '保留' : '停止'}</div><div className="story-copy"><span className="micro-label">公共冠军 {story.publicChampion?.id ?? '未产生'} · 最终去向 {story.outcome}</span><h4>{story.final ? `最终文件 ${story.final.id}` : '未形成可交付版本'}</h4><p>{story.reasons.join(' ')}</p></div></li>
    </ol>
    {story.rejected.map(candidate => <aside className="story-rejected" key={candidate.id} data-rejected={candidate.id}>
      <div className="story-rejected-label"><X size={18} /><span>没有留下的支路 · G{candidate.generation} · {candidate.parentId} → {candidate.id}</span></div>
      <h4>{candidate.title}</h4><p>{candidate.mutationEdits[0]?.reason}</p><p><b>淘汰原因</b>{candidate.rejectionReason}</p>
      <button type="button" className="text-control" onClick={() => inspect(candidate.id)}>查看被淘汰的规则原文 <ArrowRight size={16} /></button>
    </aside>)}
  </section>;
}
