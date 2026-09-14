import {
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  GitFork,
  Menu,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { GenomeFlow } from "./GenomeFlow";
import { StageNavigation } from "./features/evolution/StageNavigation";
import { EvolutionCases } from "./features/evolution/EvolutionCases";
import { EvaluationComparison } from "./features/evolution/EvaluationComparison";
import { DesignDecisions } from "./features/evolution/DesignDecisions";
import { MethodSources } from './features/evolution/MethodSources';
import { revealSection } from './features/evolution/navigation';
import { RELEASE_ID } from './release';
import { stageDetail } from "./features/evolution/caseEngine";
import { useCaseLibrary, useCasePlayback, type CasePlayback } from "./features/evolution/useCasePlayback";
import type { EvolutionCase } from "./features/evolution/types";
import "./features/evolution/evolution.css";

const navItems = [
  { label: "架构", href: "#architecture", id: "architecture" },
  { label: "案例", href: "#evidence", id: "evidence" },
  { label: "评测", href: "#evaluation", id: "evaluation" },
  { label: "设计", href: "#research", id: "research" },
  { label: "方法来源", href: "#methods", id: "methods" },
];

const githubUrl = import.meta.env.VITE_GITHUB_URL?.trim() || "https://github.com/azbigboss66-oss/skillfoo-v3";

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function useSectionSpy() {
  const [active, setActive] = useState("architecture");
  useEffect(() => {
    const sections = navItems.map(({ id }) => document.getElementById(id)).filter(Boolean) as HTMLElement[];
    const observer = new IntersectionObserver(
      (entries) => {
        const current = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (current) setActive(current.target.id);
      },
      { rootMargin: "-28% 0px -60%", threshold: [0, 0.2, 0.6] },
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);
  return active;
}

function SMark({ size = 24 }: { size?: number }) {
  return (
    <img
      className="s-mark"
      src="/assets/skillfoo-mark.png"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      decoding="async"
    />
  );
}

function SectionHeading({ index, label, title, copy }: { index: string; label: string; title: string; copy: string }) {
  return (
    <div className="section-heading">
      <div className="section-kicker"><span>{index}</span><span>{label}</span></div>
      <h2>{title}</h2>
      <p>{copy}</p>
    </div>
  );
}

function HeroMedia({ reduced }: { reduced: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (reduced) {
      video.pause();
      video.currentTime = 0.35;
      return;
    }
    void video.play().catch(() => undefined);
  }, [reduced]);
  return (
    <video ref={videoRef} className="hero-photo" autoPlay={!reduced} muted loop playsInline preload={reduced ? "metadata" : "auto"} aria-hidden="true">
      <source src="/assets/skillfoo-hero-wave.mp4" type="video/mp4" />
    </video>
  );
}

function Header({ menuOpen, setMenuOpen }: { menuOpen: boolean; setMenuOpen: (open: boolean) => void }) {
  const activeSection = useSectionSpy();
  const navRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusMenu = window.setTimeout(() => navRef.current?.querySelector<HTMLAnchorElement>("a")?.focus(), 40);
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable: HTMLElement[] = [
        ...Array.from(navRef.current?.querySelectorAll<HTMLAnchorElement>("a") ?? []),
      ];
      if (toggleRef.current) focusable.push(toggleRef.current);
      if (focusable.length === 0) return;
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? (current <= 0 ? focusable.length - 1 : current - 1)
        : (current < 0 || current === focusable.length - 1 ? 0 : current + 1);
      event.preventDefault();
      focusable[next]?.focus();
    };
    document.addEventListener("keydown", trapFocus);
    return () => {
      window.clearTimeout(focusMenu);
      document.removeEventListener("keydown", trapFocus);
      (previouslyFocused && document.contains(previouslyFocused) ? previouslyFocused : toggleRef.current)?.focus();
    };
  }, [menuOpen]);
  return (
    <>
      <button className="menu-backdrop" aria-label="点击背景关闭菜单" tabIndex={-1} onClick={() => setMenuOpen(false)} />
      <header className="header">
        <a className="logo appear appear--scale" href="#top" aria-label="SkillFoo 首页" tabIndex={menuOpen ? -1 : undefined} style={{ "--d": "0.08s" } as CSSProperties}>
          <SMark size={26} /><span>SkillFoo</span><span className="logo-suffix">V3.2</span>
        </a>
        <nav id="site-nav" className="site-nav" aria-label="主要导航" ref={navRef}>
          {navItems.map((item, index) => (
            <a
              key={item.id}
              className={`nav-pill appear ${index % 2 === 0 ? "appear--scale" : "appear--soft"}${activeSection === item.id ? " is-active" : ""}`}
              href={item.href}
              aria-current={activeSection === item.id ? "location" : undefined}
              style={{ "--d": `${0.16 + index * 0.12}s` } as CSSProperties}
              onClick={() => setMenuOpen(false)}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <a className="github-cta header-cta appear appear--scale" href={githubUrl} target="_blank" rel="noopener noreferrer" tabIndex={menuOpen ? -1 : undefined} aria-label="在 GitHub 查看 SkillFoo 项目" style={{ "--d": "0.34s" } as CSSProperties}>
          <GitFork size={17} aria-hidden="true" /><span>GitHub</span><ExternalLink className="github-external" size={13} aria-hidden="true" />
        </a>
        <button
          className="menu-toggle appear appear--scale"
          ref={toggleRef}
          type="button"
          aria-controls="site-nav"
          aria-expanded={menuOpen}
          aria-label={menuOpen ? "关闭菜单" : "打开菜单"}
          onClick={() => setMenuOpen(!menuOpen)}
          style={{ "--d": "0.34s" } as CSSProperties}
        >
          {menuOpen ? <X size={19} /> : <Menu size={19} />}
        </button>
      </header>
    </>
  );
}

function Hero({ cases }: { cases: EvolutionCase[] }) {
  const rounds = cases.reduce((total, item) => total + item.stats.generations, 0);
  const files = cases.filter(item => item.resolution.outcome === "ADOPT").length;
  return (
    <section className="hero" id="top" aria-labelledby="hero-title">
      <div className="hero-copy">
        <div className="badge appear appear--pop" style={{ "--d": "0.22s" } as CSSProperties}>
          <Sparkles className="badge-star" size={16} aria-hidden="true" />Controlled Skill Evolution
        </div>
        <h1 id="hero-title">
          <span className="headline-line"><span className="appear appear--mask" style={{ "--d": "0.42s" } as CSSProperties}>让 <em>SKILL.md</em> 在真实任务中</span></span>
          <span className="headline-line"><span className="appear appear--mask" style={{ "--d": "0.62s" } as CSSProperties}>演化，只留更好的版本。</span></span>
        </h1>
        <p className="hero-lede appear appear--soft" style={{ "--d": "0.82s" } as CSSProperties}>一个只演化 SKILL.md 的本地 CLI：输入自然语言目标，生成多轮候选，用公共集与 Direct 对照输出更好版本或保留起点。</p>
        <div className="hero-actions">
          <a className="btn btn-solid hero-btn appear appear--btn" href="#architecture" style={{ "--d": "0.96s" } as CSSProperties}>查看演化主链 <ArrowRight size={16} /></a>
          <a className="btn btn-ghost hero-btn appear appear--side" href="#evidence" style={{ "--d": "1.10s" } as CSSProperties}>查看三组演化案例 <ArrowRight size={16} /></a>
        </div>
      </div>
      <div className="hero-stats" aria-label="演化案例摘要">
        <div className="stat appear appear--stat" style={{ "--d": "1.12s" } as CSSProperties}><GitFork aria-hidden="true" /><span><strong>{cases.length}</strong>个应用方向</span></div>
        <div className="stat appear appear--stat" style={{ "--d": "1.28s" } as CSSProperties}><ShieldCheck aria-hidden="true" /><span><strong>{rounds}</strong>轮变异过程</span></div>
        <div className="stat appear appear--stat" style={{ "--d": "1.44s" } as CSSProperties}><CheckCircle2 aria-hidden="true" /><span><strong>{files}</strong>份最终 SKILL.md</span></div>
      </div>
    </section>
  );
}

function Architecture({ reduced, playback }: { reduced: boolean; playback: CasePlayback }) {
  const activeStage = playback.event.stage;
  const stage = stageDetail(playback.current, playback.state);
  return (
    <section className="content-section architecture" id="architecture">
      <SectionHeading index="01" label="Architecture" title="多路演化，最后只收束为一个选择" copy="固定起点、多代候选、独立 Direct 与条件式 holdout 各走自己的证据路径；只有合格提升才能替换 Starting Reference。" />
      <StageNavigation playback={playback} />
      <div className="architecture-frame">
        <div className="flow-shell" aria-label="候选演化轨迹">
          <GenomeFlow activeStage={activeStage} reduced={reduced} onStageChange={stage => playback.dispatch({ type: "stage", stage })} />
        </div>
        <div className="stage-detail stage-detail--case" id="stage-panel" role="tabpanel" aria-live="polite">
          <div className="stage-detail-title"><span>{stage.index}</span><div><p>当前案例 {playback.state.caseId} · {playback.current.definition.label}</p><h3>{stage.title}</h3></div></div>
          <p className="stage-summary">{stage.summary}</p>
          <dl>
            <div><dt>输入</dt><dd>{stage.input}</dd></div>
            <div><dt>执行</dt><dd>{stage.action}</dd></div>
            <div><dt>产物</dt><dd>{stage.output}</dd></div>
          </dl>
          <div className="stage-tags"><span>{playback.current.definition.routeName}</span><span>{playback.current.stats.generations} 代 · {playback.current.stats.attempts} 个尝试子代</span><a className="stage-case-link" href="#evidence">查看当前案例 →</a></div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <a href="#top" className="footer-brand"><SMark size={22} /><span>SkillFoo</span><small>V3.2</small></a>
      <p>交付完整 SKILL.md、逐项变异记录与版本差异；references 和附件保持独立。<small className="release-id" data-release-id={RELEASE_ID}>{RELEASE_ID}</small></p>
      <a href="#final-skill">查看最终版本 <ArrowRight size={14} /></a>
    </footer>
  );
}

export default function App() {
  const { cases, error } = useCaseLibrary();
  if (!cases) return <div className="case-loading" role="status">{error ? `案例加载失败：${error}` : "正在准备 SkillFoo…"}</div>;
  return <Portfolio cases={cases} />;
}

function Portfolio({ cases }: { cases: EvolutionCase[] }) {
  const reduced = useReducedMotion();
  const playback = useCasePlayback(cases, reduced);
  const [menuOpen, setMenuOpen] = useState(false);
  const [contentView, setContentView] = useState(false);
  useEffect(() => {
    const openHashTarget = () => {
      const id = window.location.hash.slice(1);
      if (id === 'candidate-lineage' || id === 'final-skill') revealSection(id, reduced);
    };
    openHashTarget();
    window.addEventListener('hashchange', openHashTarget);
    return () => window.removeEventListener('hashchange', openHashTarget);
  }, [reduced]);
  useEffect(() => {
    document.body.classList.toggle("menu-open", menuOpen);
    const background = document.querySelectorAll<HTMLElement>(".hero, main, .footer");
    background.forEach((element) => menuOpen ? element.setAttribute("inert", "") : element.removeAttribute("inert"));
    return () => {
      document.body.classList.remove("menu-open");
      background.forEach((element) => element.removeAttribute("inert"));
    };
  }, [menuOpen]);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    const media = window.matchMedia("(min-width: 901px)");
    const closeOnDesktop = () => { if (media.matches) setMenuOpen(false); };
    document.addEventListener("keydown", closeOnEscape);
    media.addEventListener("change", closeOnDesktop);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      media.removeEventListener("change", closeOnDesktop);
    };
  }, []);
  useEffect(() => {
    const elements = [...document.querySelectorAll<HTMLElement>(".appear, .hero-photo")];
    const complete = (element: HTMLElement) => element.classList.add("is-in");
    elements.forEach((element) => element.addEventListener("animationend", () => complete(element), { once: true }));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      elements.forEach((element) => {
        const animations = element.getAnimations();
        if (!animations.some((animation) => animation.playState === "running" || animation.playState === "finished")) complete(element);
      });
    }));
  }, []);
  useEffect(() => {
    const sections = [...document.querySelectorAll<HTMLElement>(".content-section")];
    let frame = 0;
    const commit = () => {
      frame = 0;
      const viewportCenter = window.innerHeight * 0.5;
      const insideGlassPanel = sections.some((section) => {
        const rect = section.getBoundingClientRect();
        const inset = Number.parseFloat(getComputedStyle(section).getPropertyValue("--glass-inset-y")) || 0;
        return viewportCenter >= rect.top + inset && viewportCenter <= rect.bottom - inset;
      });
      setContentView((current) => current === insideGlassPanel ? current : insideGlassPanel);
    };
    const update = () => {
      if (!frame) frame = requestAnimationFrame(commit);
    };
    const resize = new ResizeObserver(update);
    sections.forEach((section) => resize.observe(section));
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      resize.disconnect();
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return (
    <div className={`site-shell${contentView ? " is-content-view" : ""}`}>
      <HeroMedia reduced={reduced} />
      <div className="hero-viewport">
        <div className="hero-page"><Header menuOpen={menuOpen} setMenuOpen={setMenuOpen} /><Hero cases={cases} /></div>
      </div>
      <main><Architecture reduced={reduced} playback={playback} /><EvolutionCases playback={playback} /><EvaluationComparison playback={playback} /><DesignDecisions playback={playback} /><MethodSources playback={playback} /></main>
      <Footer />
    </div>
  );
}
