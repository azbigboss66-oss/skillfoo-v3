import { Check, Copy, Download, FileCode2, GitCompareArrows } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { finalOutput, formatScore, lineDiff, score } from "./caseEngine";
import type { EvolutionCase } from "./types";

export function InputOutput({ current }: { current: EvolutionCase }) {
  const d = current.definition;
  const adopted = current.resolution.outcome === "ADOPT";
  if (current.resolution.outcome === 'FAILED') return <div className="input-output case-surface"><h3>本次未形成可交付版本</h3><p>{current.resolution.reasons.join(' ')}</p><details className="inline-disclosure"><summary>查看原版本输出</summary><p>{d.before}</p></details></div>;
  return <div className="input-output case-surface">
    <div className="module-title"><span>01 / 改前与改后</span><small>{d.application}</small></div>
    <div className="output-pair"><div className="output-before"><div className="output-caption"><span>原版本输出</span><b>{current.starting.id} · {formatScore(score(current.starting.publicScorecard!))}</b></div><p>{d.before}</p></div>
    <div className="output-after"><div className="output-caption"><span>{adopted ? "最终版本输出" : "保留版本输出"}</span><b>{current.final.id} · {formatScore(score(current.final.publicScorecard!))}</b></div><p>{finalOutput(current)}</p>{adopted && d.reviewedObjectDecision && <p className="object-boundary"><Check size={15} aria-hidden="true" /><span>采用的是审核 Skill；客户方案仍须补齐依据，未获批准。</span></p>}</div>
    </div>{adopted ? <div className="improvement-list">{d.improvements.map((item,index) => <div key={item.label}><span>0{index+1}</span><p><strong>{item.label}</strong>{item.text}</p></div>)}</div> : <p className="protected-note">{current.resolution.reasons.join(" ")}</p>}
    <div className="direct-observation"><div className="output-caption"><span>相比一次改写，多路演化多解决了什么</span><b>Direct {formatScore(score(current.direct.publicScorecard!))} 分</b></div><p>{d.direct.limitation}</p><details className="inline-disclosure"><summary>查看独立 Direct 的输出 <span>从冻结 {d.direct.rootId} 派生</span></summary><p>{d.direct.output}</p></details></div>
    <details className="inline-disclosure"><summary>查看输入任务与完整材料 <span>{d.inputs.length} 份材料</span></summary><div className="source-list">{d.inputs.map(input => <article key={input.id}><span>{input.id}</span><h4>{input.title}</h4><p>{input.text}</p></article>)}</div></details>
    <details className="inline-disclosure"><summary>原 Skill 的问题与保留项</summary><ul className="plain-list">{d.issues.map(issue => <li key={issue}>{issue}</li>)}</ul><p className="protected-note"><b>保护项</b>{d.protectedBehavior}</p></details>
  </div>;
}

export function SkillDelivery({ current }: { current: EvolutionCase }) {
  const [view, setView] = useState<"file" | "diff" | null>(null);
  const [feedback, setFeedback] = useState("");
  const operation = useRef(0);
  const rows = useMemo(() => lineDiff(current.starting.skillContent, current.final.skillContent), [current]);
  useEffect(() => () => { operation.current++; }, []);
  if (current.resolution.finalCandidateId === null) return <div className="skill-delivery case-surface" id="final-skill"><h3>未形成可交付版本</h3><p>{current.resolution.reasons.join(' ')}</p></div>;
  const copy = async () => {
    const ticket = ++operation.current;
    setFeedback("正在复制…");
    try {
      await navigator.clipboard.writeText(current.final.skillContent);
      if (ticket === operation.current) setFeedback(`已复制 ${current.final.id} 的完整 SKILL.md`);
    } catch {
      if (ticket === operation.current) { setFeedback("复制失败，请打开完整文件，手动选择复制。"); setView("file"); }
    }
  };
  const download = () => {
    try {
      const url = URL.createObjectURL(new Blob([current.final.skillContent], { type: "text/markdown;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url; link.download = `${current.definition.id}-${current.final.id}-SKILL.md`;
      document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
      setFeedback(`已生成 ${current.final.id} 下载文件`);
    } catch { setFeedback("下载未能生成，请查看或复制完整文件。"); }
  };
  return <div className="skill-delivery case-surface" id="final-skill">
    <div className="delivery-heading"><div><span className="micro-label">03 / 最终版本</span><h3><FileCode2 size={23} aria-hidden="true" />SKILL.md <small>{current.final.id}</small></h3><p>完整指令正文；references 与附件保持独立。下方预览、差异、复制和下载使用同一份内容。</p></div><span className="decision-pill"><Check size={15} />{current.resolution.outcome}</span></div>
    <div className="file-actions">
      <button type="button" className="case-button case-button--light" aria-expanded={view === "file"} aria-controls="skill-code-panel" onClick={() => setView(view === "file" ? null : "file")}><FileCode2 size={16} />查看完整 SKILL.md</button>
      <button type="button" className="case-button" aria-expanded={view === "diff"} aria-controls="skill-code-panel" onClick={() => setView(view === "diff" ? null : "diff")}><GitCompareArrows size={16} />查看与起点的差异</button>
      <button type="button" className="case-button" onClick={() => void copy()}><Copy size={16} />复制最终版本</button>
      <button type="button" className="case-button" onClick={download}><Download size={16} />下载 SKILL.md</button>
    </div>
    <details className="inline-disclosure file-meta"><summary>文件身份与校验 <span>UTF-8 · {new TextEncoder().encode(current.final.skillContent).length.toLocaleString()} bytes</span></summary><code>SHA-256 {current.final.skillHash}</code></details>
    <p className="file-feedback" role="status">{feedback}</p>
    <div id="skill-code-panel" hidden={!view}>
      {view === "file" && <pre className="skill-code" tabIndex={0} aria-label={`${current.final.id} 完整 SKILL.md`}><code>{current.final.skillContent}</code></pre>}
      {view === "diff" && <div className="skill-code diff-code" tabIndex={0} aria-label={`${current.starting.id} 到 ${current.final.id} 的完整差异`}>{rows.map((row,index) => <div className={`diff-line diff-line--${row.kind}`} key={index}><span aria-hidden="true">{row.kind === "add" ? "+" : row.kind === "remove" ? "−" : " "}</span><code>{row.text || " "}</code></div>)}</div>}
    </div>
  </div>;
}
