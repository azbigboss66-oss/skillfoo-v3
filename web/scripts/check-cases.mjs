import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyEdits, buildCase, buildCases, score, contentHash, selectPublicCandidate, resolveCase, ancestryOf, lineDiff, initialPlayback, reducePlayback, comparisonScores, finalOutput, stageDetail } from '../src/features/evolution/caseEngine.ts';

const definitions = JSON.parse(await readFile(new URL('../src/data/evolution-cases.json', import.meta.url), 'utf8'));
const cases = await buildCases(definitions);
let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions++; };
assert.equal(cases.length, 3);
const expectations = [
  { rounds: 3, attempts: 6, starting: 'B0', winner: 'A-e3', scores: [70.8, 69.6, 92, 82.3], holdout: [71.3, 90.4, 81.2] },
  { rounds: 3, attempts: 6, starting: 'S0', winner: 'B-e3', scores: [75.1, 79.2, 91.65, 84.55], holdout: [78.3, 90.4, 84] },
  { rounds: 2, attempts: 4, starting: 'B0', winner: 'C-e2', scores: [89.15, 87, 93.95, 90.4], holdout: [88.6, 93.25, 89.85] },
];
for (const [index, current] of cases.entries()) {
  const e = expectations[index];
  check(current.stats.generations === e.rounds && current.stats.attempts === e.attempts, '代数和尝试数');
  check(current.starting.id === e.starting && current.champion.id === e.winner, '计算起点和冠军');
  check(current.resolution.outcome === 'ADOPT' && current.final.id === e.winner, '默认三案采用新版本');
  assert.deepEqual([current.byId.B0, current.byId.S0, current.champion, current.direct].map(c => score(c.publicScorecard)), e.scores);
  assert.deepEqual(Object.values(current.holdout).map(result => score(result.dimensions)), e.holdout);
  for (const candidate of current.candidates) {
    check(candidate.trainScore === score(candidate.trainScorecard), 'train 也由五维加权计算');
    ancestryOf(candidate.id, current.byId);
    check(candidate.skillHash === await contentHash(candidate.skillContent), '内容 hash 一致');
    if (candidate.parentId) {
      const parent = current.byId[candidate.parentId];
      check(parent && parent.generation < candidate.generation, '父版本先于子版本');
      check(parent.skillHash !== candidate.skillHash, '子代发生实际文本变化');
      check(applyEdits(parent.skillContent, candidate.diff) === candidate.skillContent, 'diff 可重建子代');
    }
    check(candidate.qualification.eligible === !!candidate.publicScorecard, '资格与公共比较一致');
  }
  for (const generation of current.generations) {
    check(generation.after.anchorId === 'B0', 'Anchor 冻结');
    check(current.byId[generation.after.eliteId].strategy !== current.byId[generation.after.diversityId].strategy, 'Diversity 不复制 Elite 策略');
  }
  const independent = applyEdits(current.byId[current.definition.direct.rootId].skillContent, current.definition.direct.edits);
  check(independent === current.direct.skillContent, 'Direct 只来自冻结根');
  const rows = lineDiff(current.starting.skillContent, current.final.skillContent);
  check(rows.filter(row => row.kind !== 'remove').map(row => row.text).join('\n') === current.final.skillContent, '完整 diff 重建交付文件');
  const invalid = current.candidates.find(c => !c.qualification.eligible);
  const highInvalid = { ...invalid, publicScorecard: [100, 100, 100, 100, 100] };
  check(selectPublicCandidate(current.roots, [highInvalid]).championId === null, '不合格候选高分也不能胜出');
  const insufficient = { ...current.champion, publicScorecard: current.starting.publicScorecard };
  check(selectPublicCandidate(current.roots, [insufficient]).championId === null, '增益不足 3 分保留起点');
  check(resolveCase(current.publicDecision, current.direct, null, current.candidates).outcome === 'RETAIN', '复核未完成不能采用');
  const failHoldout = structuredClone(current.holdout);
  failHoldout.adaptive.passed = false;
  check(resolveCase(current.publicDecision, current.direct, failHoldout, current.candidates).outcome === 'RETAIN', '复核失败不能采用');
  const switchedHoldout = structuredClone(current.holdout);
  switchedHoldout.adaptive.candidateId = 'wrong-case';
  check(resolveCase(current.publicDecision, current.direct, switchedHoldout, current.candidates).outcome === 'RETAIN', '复核身份不串案');
  const editedHoldout = structuredClone(current.holdout);
  editedHoldout.adaptive.skillHash = 'changed-content';
  check(resolveCase(current.publicDecision, current.direct, editedHoldout, current.candidates).outcome === 'RETAIN', '同名不同内容不能复用复核');
  check(comparisonScores(current, 'holdout').every(Boolean), '默认复核三份身份与内容完整匹配');
  check(current.events.slice(0, -1).reduce((sum, event) => sum + event.duration, 0) >= 18000 && current.events.slice(0, -1).reduce((sum, event) => sum + event.duration, 0) <= 25000, '播放 18–25 秒');
  check(current.events.findIndex(event => event.stage === 6) > current.events.findIndex(event => event.stage === 5), '先固定比较版本再复核');
}
check(cases[1].ancestry.includes('B-d1'), 'B 冠军源于探索分支');
check(cases[2].final.skillContent.includes('普通讨论、头脑风暴和一般分析直接回答'), '成熟能力保护');
check(!/甲制造|乙物流|丙装备/.test(cases[1].final.skillContent), 'B 的 Skill 规则按 BANT 状态而非固定客户顺位');
check(!/第 3 节|第 5 节/.test(cases[2].final.skillContent), 'C 的 Skill 定位真实章节而非固定样例章节');
const sameScoreRoots = cases[0].roots.map(c => ({...c,publicScorecard:[80,80,100,80,80]})).reverse();
check(selectPublicCandidate(sameScoreRoots, []).startingReferenceId === 'B0', '起点同分保留 B0');
const arbitrary = {...cases[0].publicDecision, championId:null};
check(resolveCase(arbitrary,cases[0].direct,cases[0].holdout,cases[0].candidates).outcome === 'RETAIN', '决策不是 caseId 强制 ADOPT');
assert.throws(() => applyEdits('abc', [{target:'missing',replacement:'x',reason:'test'}]));
assert.throws(() => applyEdits('abc abc', [{target:'abc',replacement:'x',reason:'test'}]));
assert.throws(() => applyEdits('abc', [{target:'abc',replacement:'abc',reason:'test'}]));
assert.throws(() => score([100,NaN,90,90,90]));
const cyclic = structuredClone(cases[0].byId); cyclic.B0.parentId = 'A-e3';
assert.throws(() => ancestryOf('A-e3', cyclic));
let state = initialPlayback(cases[0]);
state = reducePlayback(state, {type:'start',reduced:false},cases);
state = reducePlayback(state, {type:'case',caseId:'B'},cases);
const stable = reducePlayback(state, {type:'step',delta:1,automatic:true,caseId:'A',expectedIndex:0},cases);
check(JSON.stringify(stable) === JSON.stringify(state), '旧定时器无法污染新案例');
check(!reducePlayback(state,{type:'start',reduced:true},cases).playing,'reduced motion 不自动播放');
const isolatedDefs=structuredClone(definitions); isolatedDefs[0].holdout.adaptive=[0,0,0,0,0];
const isolated=await buildCases(isolatedDefs);
check(isolated[0].champion.id===cases[0].champion.id && isolated[0].resolution.outcome==='RETAIN','holdout 不反馈公共选择');
const changedWinnerDefinition = structuredClone(definitions[0]);
changedWinnerDefinition.candidates.find(candidate => candidate.id === 'A-e3').publicScorecard = [64,64,100,60,64];
const changedWinner = await buildCase(changedWinnerDefinition);
check(changedWinner.champion.id === 'A-e2', '公共成绩变化后重新选出实际最高候选');
check(changedWinner.holdout.adaptive.candidateId === 'A-e3', '既有复核保留原版本身份而非重命名');
check(changedWinner.resolution.outcome === 'RETAIN', '新冠军没有自己的复核时保留起点');
check(comparisonScores(changedWinner, 'holdout')[1] === null, '界面不能展示另一候选的复核分数');
const editedDefinition = structuredClone(definitions[0]);
editedDefinition.candidates.find(candidate => candidate.id === 'A-e3').mutationEdits[0].replacement += '\n输出前再次核对各条资料 ID。';
const edited = await buildCase(editedDefinition);
check(edited.champion.id === 'A-e3' && edited.champion.skillHash !== cases[0].champion.skillHash, '同一候选 ID 的文本变化确实生成新 hash');
check(edited.resolution.outcome === 'RETAIN' && comparisonScores(edited, 'holdout')[1] === null, '改过正文必须重新复核');
const noChampionDefinition = structuredClone(definitions[0]);
noChampionDefinition.candidates.forEach(candidate => { if(candidate.publicScorecard) candidate.publicScorecard = [64,64,100,60,64]; });
const noChampion = await buildCase(noChampionDefinition);
check(noChampion.champion === null && noChampion.final.id === 'B0' && noChampion.resolution.outcome === 'RETAIN', '无有效增益时保留 B0');
check(comparisonScores(noChampion, 'public')[1] === null && comparisonScores(noChampion, 'holdout')[1] === null, '无冠军状态不产生 Adaptive 比较分数');
check(finalOutput(noChampion) === noChampion.definition.before, '保留起点时不展示预置改善输出');
check(stageDetail(noChampion, {...initialPlayback(noChampion), eventIndex:noChampion.events.findIndex(event=>event.stage===6)}).input.includes('没有满足公共增益要求'), '无冠军的架构复核详情不假定三版本已选');
if (process.argv[2]) {
  const out=path.resolve(process.argv[2]); await mkdir(out,{recursive:true});
  for(const c of cases) await writeFile(path.join(out,`${c.definition.id}-SKILL.md`),c.final.skillContent);
  await writeFile(path.join(out,'case-contracts.json'),JSON.stringify({assertions,cases:cases.map(c=>({id:c.definition.id,stats:c.stats,starting:c.starting.id,champion:c.champion.id,outcome:c.resolution.outcome,ancestry:c.ancestry,hash:c.final.skillHash,delta:c.publicDecision.delta,reviewIdentities:{starting:{candidateId:c.starting.id,skillHash:c.starting.skillHash},adaptive:{candidateId:c.champion.id,skillHash:c.champion.skillHash},direct:{candidateId:c.direct.id,skillHash:c.direct.skillHash}}}))},null,2));
}
console.log(`PASS: ${assertions} case contracts + weighted-score / invalid-input / cycle assertions. All 3 cases resolve through eligibility, public selection and independent review.`);
