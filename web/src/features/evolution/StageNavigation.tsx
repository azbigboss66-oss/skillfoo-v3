import { STAGE_NAMES } from './caseEngine';
import type { CasePlayback } from './useCasePlayback';

export function StageNavigation({ playback }: { playback: CasePlayback }) {
  return <div className="stage-navigation">
    <p id="stage-navigation-label">点击阶段，查看输入、执行与产物</p>
    <div className="stage-navigation-grid" role="group" aria-labelledby="stage-navigation-label">
      {STAGE_NAMES.map((name, stage) => <button type="button" key={name}
        aria-pressed={playback.event.stage === stage} aria-controls="stage-panel"
        onClick={() => playback.dispatch({ type: 'stage', stage })}>
        <span>{String(stage + 1).padStart(2, '0')}</span><strong>{name}</strong>
      </button>)}
    </div>
  </div>;
}
