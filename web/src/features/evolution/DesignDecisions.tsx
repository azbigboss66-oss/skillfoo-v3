import { ArrowUpRight } from "lucide-react";
import { DetailHeading } from "./CaseControls";
import { revealSection } from './navigation';
import type { CasePlayback } from "./useCasePlayback";

export function DesignDecisions({ playback }: { playback: CasePlayback }) {
  const jump = (target: string) => revealSection(target, playback.reduced);
  const items=[
    {title:"为什么不是一次改写就结束？",problem:"一次改写可能只改善表面表达，未触及影响判断的策略。",mechanism:"保留独立 Direct，让 exploit 细化有效策略，让 diversify 探索不同改法；合格候选回到累计池竞争。",example:"案例 B：B-d1 把“可推进程度”放在前面，超过同代 exploit；后续两代沿这条探索分支精修，形成 B-e3。",label:"查看 B 的探索起源",action:()=>{playback.locateCandidate("B","B-d1");jump("candidate-lineage");}},
    {title:"为什么保留 Anchor？",problem:"新指令可能改善一项表现，却破坏成熟版本原本正确的行为。",mechanism:"B0 冻结，保护项参与资格判断；候选失败仅淘汰自己，兄弟分支和合格起点继续保留。",example:"案例 C：C-d1 把普通讨论也强制送进完整审核，因保护项失败被淘汰；C-e1 继续，Diversity 回到 S0。",label:"查看 C 的过度审核子代",action:()=>{playback.locateCandidate("C","C-d1");jump("candidate-lineage");}},
    {title:"为什么分公共选择与独立复核？",problem:"针对反馈优化的版本，需要在另一组任务上检查能否保持改善。",mechanism:"公共选择结束后固定 Starting Reference、Adaptive、Direct 三份版本，再进入独立复核；复核不反向影响选拔。",example:`当前案例 ${playback.current.definition.id}：使用另一组材料检查具体行为，只有资格、公共增益与复核同时满足，才采用新 Skill。`,label:"打开当前案例的独立复核",action:()=>{playback.dispatch({type:"stage",stage:6});playback.dispatch({type:"evaluation",tab:"holdout"});jump("evaluation");}},
  ];
  return <section className="content-section content-section--detail design-decisions" id="research"><DetailHeading index="04" label="Design decisions" title="这些机制，分别解决什么问题">从具体失败方式出发，把方法落实为边界清楚、能够检查的选择规则。</DetailHeading>
    <div className="design-grid">{items.map((item,index)=><article className="case-surface design-item" key={item.title}><span className="design-number">0{index+1}</span><h3>{item.title}</h3><dl><div><dt>具体问题</dt><dd>{item.problem}</dd></div><div><dt>机制怎么工作</dt><dd>{item.mechanism}</dd></div><div><dt>案例中的实例</dt><dd>{item.example}</dd></div></dl><button type="button" className="text-control" onClick={item.action}>{item.label}<ArrowUpRight size={16}/></button></article>)}</div>
  </section>;
}
