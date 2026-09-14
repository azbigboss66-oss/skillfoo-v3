import { ArrowUpRight, ExternalLink } from 'lucide-react';
import { METHOD_SOURCES } from '../../data/method-sources';
import { DetailHeading } from './CaseControls';
import { revealSection } from './navigation';
import { STAGE_NAMES } from './caseEngine';
import type { CasePlayback } from './useCasePlayback';

export function MethodSources({ playback }: { playback: CasePlayback }) {
  return <section className="content-section content-section--detail method-section" id="methods">
    <DetailHeading index="05" label="Method sources" title="从研究方法，到可检查的机制">这些研究启发了多路探索、反馈改进与保守选择。下面区分项目已有参考与相关方法，说明借鉴了什么、没有照搬什么。</DetailHeading>
    <p className="method-year-note">年份统一按首次 arXiv 发布；原文与具体机制均可直接查看。</p>
    <div className="method-grid">{METHOD_SOURCES.map(method => <article className="method-item" key={method.name}>
      <div className="method-meta"><span>{method.kind === 'reference' ? '已有方法参考' : '相关方法'}</span><span>{method.year}</span></div>
      <h3>{method.name}</h3><p className="method-title" lang="en">{method.title}</p><p className="method-author">{method.author}</p>
      <p className="method-idea">{method.idea}</p><p className="method-mapping">{method.mapping}</p><p className="method-boundary">{method.boundary}</p>
      <div className="method-actions"><a href={method.url} target="_blank" rel="noreferrer">阅读原文 <ExternalLink size={15} /></a>
        {method.stage !== undefined && <button type="button" onClick={() => { playback.dispatch({ type: 'stage', stage: method.stage! }); revealSection('architecture', playback.reduced); }}>查看对应机制 · {STAGE_NAMES[method.stage]} <ArrowUpRight size={15} /></button>}
      </div>
    </article>)}</div>
  </section>;
}
