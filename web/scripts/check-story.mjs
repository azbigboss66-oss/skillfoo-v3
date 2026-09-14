import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildCases, buildCase, initialPlayback, reducePlayback } from '../src/features/evolution/caseEngine.ts';
import { evolutionStory } from '../src/features/evolution/storyModel.ts';

const definitions = JSON.parse(await readFile(new URL('../src/data/evolution-cases.json', import.meta.url), 'utf8'));
const cases = await buildCases(definitions);
let count=0; const check=(ok, reason)=>{ assert.ok(ok,reason); count++; };
for (const c of cases) {
  const story=evolutionStory(c);
  check(story.adopted && story.final.id===c.final.id, 'story follows actual ADOPT');
  assert.deepEqual([story.root.id,...story.steps.map(s=>s.candidate.id)], c.ancestry); count++;
  for (const step of story.steps) {
    check(step.parent.id===step.candidate.parentId, 'real parent');
    check(step.generation.number===step.candidate.generation, 'real generation');
    check(step.candidate.qualification.eligible, 'only eligible path retained');
    for (const [i,edit] of step.edits.entries()) {
      check(step.candidate.mutationEdits[i].target.includes(edit.before), 'before excerpt exact');
      check(step.candidate.mutationEdits[i].replacement.includes(edit.after), 'after excerpt exact');
      check(step.candidate.mutationEdits[i].reason===edit.reason, 'edit reason exact');
    }
  }
  check(story.rejected.every(r=>!r.qualification.eligible && !!r.rejectionReason), 'rejected branch uses qualifications');
  let s=initialPlayback(c);
  s=reducePlayback(s,{type:'stage',stage:3},cases);
  check(s.generation===1, 'enter population from final starts G1');
  s=reducePlayback(s,{type:'generation',generation:2},cases);
  s=reducePlayback(s,{type:'stage',stage:3},cases);
  check(s.generation===2, 'repeat population preserves G2');
  s=reducePlayback(s,{type:'stage',stage:4},cases);
  s=reducePlayback(s,{type:'stage',stage:3},cases);
  check(s.generation===1, 're-enter after public starts G1');
  const stable=reducePlayback(s,{type:'generation',generation:c.stats.generations+1},cases);
  check(stable===s, 'invalid generation rejected');
}
check(evolutionStory(cases[1]).steps[0].candidate.id==='B-d1' && evolutionStory(cases[1]).steps[0].exploration, 'B exploration ancestry retained');
check(evolutionStory(cases[2]).rejected.some(c=>c.id==='C-d1'), 'C over-review rejection retained');
const altered=structuredClone(definitions[0]); altered.holdout.adaptive=[0,0,0,0,0];
const retained=await buildCase(altered), retainedStory=evolutionStory(retained);
check(!retainedStory.adopted && retainedStory.steps.length===0 && retainedStory.final.id==='B0', 'RETAIN never uses preset successful child story');
const failed=structuredClone(cases[0]); failed.resolution={outcome:'FAILED',finalCandidateId:null,reasons:['No qualified result']}; failed.final=failed.starting; failed.ancestry=[failed.starting.id];
check(evolutionStory(failed).final===null && !evolutionStory(failed).adopted && evolutionStory(failed).title.includes('未能交付'), 'FAILED has no adopted story');
const hook=await readFile(new URL('../src/features/evolution/useCasePlayback.ts',import.meta.url),'utf8');
check(!/setTimeout|setInterval|requestAnimationFrame/.test(hook), 'shared manual hook has no timer');
for(const file of ['CaseControls.tsx','EvolutionCases.tsx']) {
 const source=await readFile(new URL('../src/features/evolution/'+file,import.meta.url),'utf8');
 check(!/PlaybackControls|播放演进|暂停演进|继续演进|重新开始|EvolutionTheater/.test(source), 'no playback/modal UI '+file);
}
const result={checks:count,cases:cases.map(c=>({id:c.definition.id,ancestry:c.ancestry,storySteps:evolutionStory(c).steps.map(s=>s.candidate.id),rejected:evolutionStory(c).rejected.map(r=>r.id),final:c.final.id,hash:c.final.skillHash}))};
if(process.argv[2]) {await mkdir(path.dirname(path.resolve(process.argv[2])),{recursive:true});await writeFile(process.argv[2],JSON.stringify(result,null,2));}
console.log(`PASS: ${count} story/manual-navigation contracts.`);
