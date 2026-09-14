# U1 current-v3 最终执行账本

当前摘要日期：2026-09-14（Asia/Shanghai）
源码 HEAD：`960aad29ba6186f5869d48f43c6cb4e7f4ba52e7`；历史恢复基线：`4fadaa3290ab6cd02d2d108bf2ddd36f9a064a14`
最近一次正式运行：formal human、DeepSeek `deepseek-v4-flash`、`--no-release`（详见第 14 节）
当前终局：三案均完成 Adaptive、terminal public-select、Direct 和 no-entry 封账；Case 1/3 保留 B0，Case 2 保留 S0，没有合格 evolved champion，sealed body 读取为 0，未发布。

第 5–12 节保留的是早期合同、资格和 Pairwise 纠偏期间的历史事实，其中旧 `not_comparable`、旧 Direct/sealed 阻断均已被第 14 节的当前结果取代；这些历史记录不再代表当前运行状态。

## 1. 当前唯一产品链

保留的生产链：

`SKILL.md + 自然语言目标 -> Task Card human 1/2 -> evaluation human 2/2 -> freeze -> B0/S0 -> Anchor/Elite/Diversity -> exploit/diversify -> public-train -> public-select -> Direct（仅有真实 comparison baseline 时） -> 条件 sealed -> retain/replace -> no-release`

正式边界：

- 生产 formal path 只接受 human 2/2；`humanConfirmationBypassed=false`。
- `test-fixture` 仅用于零网络自动化测试，不能形成 formal evidence、调用 public Provider、进入 sealed 或模拟真人身份。
- 只变异 `SKILL.md`；reference/script 仅是 hash-bound、只读运行上下文。
- 评分身份：`u1-scoring-profile-v3 / u1-task-verifier-v3 / u1-five-dimension-rubric-v2`。
- 动态调用包络 multiplier=`2.0`；Token 为 provider-default/observe-only。
- public-select、Direct、sealed 预算隔离；sealed 无应用层 schema repair。

当前公开 CLI 命令共 13 个：

`doctor, intake, eval-draft, eval-review, eval-freeze, bootstrap, preflight, provider-check, calibration-run, adaptive-run, direct-run, audit-compare, suite-report`

## 2. 共享 semantic schema recovery

当前统一语义：

- 每个非 sealed semantic batch 第一次收到可恢复结构错误后，只允许一次内容无关 schema repair。
- 可恢复错误仅限：`SEMANTIC_JUDGE_INVALID_JSON`、`SEMANTIC_JUDGE_INVALID`、`SEMANTIC_JUDGE_ITEM_MISMATCH`、`SEMANTIC_JUDGE_DIMENSION_MISMATCH`、`SEMANTIC_JUDGE_OVERALL_REASON_INVALID`。
- repair 不携带被拒绝正文；失败后保留原错误并停止；禁止第三次。
- Provider、timeout、transport、预算、安全、能力边界、低分和选择失败不触发 schema repair。
- calibration 为 2 个 primary pass + 最多 2 个独立 schema-repair reserve，授权 H=4，transport retry=0。
- public-select 与 Direct 强制使用 public semantic judge；sealed 使用独立的 no-recovery judge。

聚焦验证：

- 精确 RED：calibration pass 1 非 JSON、repair 合法、pass 2 合法时，旧实现以 `SEMANTIC_JUDGE_INVALID_JSON` 失败。
- GREEN 覆盖：calibration 2/3/4 次逻辑调用、repair 再失败无第三次、transport 失败不 repair、public-select/Direct 同一恢复语义、sealed 首次非法即失败。
- Case 3 产物校验直接回归：旧校验把同一 generation/lane 错当成至多一个 recovery，并禁止完成结果保留局部失败 repair。Focused RED=`3 pass / 1 fail`；最小计数修复后 `4/4`，相邻 Adaptive/public-select/archive 回归 `56/56`。

## 3. 清理结果

整文件删除的旧生产职责包括：

- V2 bounded evolution、V2 public contract、V2 artifact writer；
- closure-v2 reconciliation 与旧 preflight/report；
- 旧 evaluate/evolve/funnel/instruction runner、旧 snapshot/release ledger；
- 已无消费者的旧 adapter/runner/score/patch/population 实现。

删除的旧命令：`inspect, evaluate, evolve, instruction-run, funnel-run, freeze-contract`。

删除的产品外内容：

- tracked `demo/` 及 package/CI/docs 引用；
- tracked `projects/github-research/`、`projects/real-skill-suite/`、`projects/v3-instruction-sample/`、`projects/v3.2-validation/`；
- 旧 closure report、旧 final plan；
- 本地旧 current-v2 case、重复 provider-check、superseded attempt/staging/audit；
- 根目录四份未跟踪旧 `V3_2_*` 过程计划。

保留的兼容仅限仍有当前消费者的内部 cache context 适配和当前 artifact reader；它们不生成旧合同、不决定 current-v3 路由、不出现在 public CLI。

生产 TypeScript 相对恢复基线：`+3268 / -20750`，净减 `17482` 行（约 `38.36%`）；无新增文件，存在实质删除。

生产代码禁用符号零命中：`historical-development-fixture`、`development-bypass`、`u1-b-development-closure-v2`、`U1_B_DEVELOPMENT_CLOSURE_PROTOCOL`、`index-order-v1`、`legacy-global-both-roles`、`legacyEnvelopeWithoutSemanticRecovery`、`runEvolutionV2`、`writeV2Artifacts`、`loadPublicV2Contract`、`runCliForHistoricalDevelopmentFixtures`、`allow-recognized-superseded`。测试中的旧词只作为负向断言保留。

## 4. 冻结案例身份

| Case | 预注册层级 | Contract | B0 | S0 | human |
|---|---|---|---|---|---|
| 1 | 低；controlled degradation | `ae8b3ab9da0a45c138024e73f66dd7053f2b9660539c319053d200a2b7faf675` | `a41d0162fa52766d93204bf22f46564e09cd2cf14bca6e7d7f1787e0162edf64` | `0bbf3f6d106ee48ad21771c5d0d765a5656268d6c89cef20e5d667d08982de22` | 2/2 |
| 2 | 中；medium derivation | `0fea1f8bcd4d9720e877e6ea738b9bb6a7c5fe6afad38f25759ad910ab76bf9c` | `952decea5c72b614330f41f30e6159b2c57dcf902b2f724e7fbcf62e2d7f3ab6` | `2878118df4754ea56e4be9709363d45734f5d02ff5ccada735e8c8f29c2d87eb` | 2/2 |
| 3 | 高；untouched source | `62185962666fa66525d53fa6ec093ff7cbdf9f2317ce459eb2258c3dede96f16` | `e2587a303205083c1d05ae2181048d7b795420c9d2a9ed0873cfcebe1f261bd5` | `1756f8a93550a01342af5d8c648f47f0f0a8e9f423efb0819bd6df5683f10b6c` | 2/2 |

三案均为 8 public-train / 6 terminal public-select / 3 sealed，且 `formalEvidence=true`、无 bypass、release withheld。

## 5. 真实运行结果

调用格式为 `logical / HTTP / transport retry`；Token 为 `prompt / completion`。

### Case 1

- Calibration：passed；median Good/Borderline/Unsafe=`92.75 / 43.5 / 9`；`2/2/0`；schema repair=0；Token=`2174/1194`。
- Adaptive：`stagnation_stop`；train elite=`b0-anchor`，score=84；`104/104/0`；schema repair=0；Token=`186089/34711`；elapsed=`176211 ms`。
- Public-select：`34/34/0`；schema repair=0；Token=`56908/10446`。
- Public 候选：
  - B0=76，五维=`75 / 77.5 / 78.33 / 73.33 / 77.5`；comparison=false（quality gate）。
  - S0=63，五维=`61.17 / 64.67 / 63.33 / 64.17 / 60.5`；comparison=false（quality gate）。
  - evolved `g2-diversify`=67，五维均 66.67；comparison=false（redline + quality gate）。
- 终局：`not_comparable / no_comparison_baseline`；Starting Reference=null；champion=null。
- Direct：正式 execute 入口在 Provider 前以 `DIRECT_RUN_NOT_COMPARABLE` 拒绝；无 Direct 分数或调用。
- Sealed：未进入；body read=0，Provider call=0。

### Case 2

- Calibration：passed；median=`98.125 / 75.875 / 8.5`；`2/2/0`；schema repair=0；Token=`2688/1509`。
- Adaptive：`stagnation_stop`；train elite=`g1-exploit`，score=80；`62/62/0`；application schema recovery=1；Token=`150640/32388`；elapsed=`225714 ms`。
- 唯一 recovery 为 mutation `g1/diversify` 的 `LIVE_PROPOSAL_INVALID -> format-repair`，一次成功、无第三次。Case 2 calibration 实际没有使用 schema repair。
- Public-select：`31/31/0`；schema repair=0；Token=`51481/15028`。
- Public 候选：
  - B0=17，五维=`13.33 / 16.67 / 8.33 / 80.83 / 33.33`；comparison=false。
  - S0=7，五维=`0 / 0 / 8.33 / 76.67 / 11.11`；comparison=false。
  - evolved `g1-exploit`=48，五维=`64.17 / 65 / 63.33 / 64.17 / 61.67`；comparison=false。
- 终局：`not_comparable / no_comparison_baseline`；Starting Reference=null；champion=null。
- Direct：正式 execute 入口在 Provider 前以 `DIRECT_RUN_NOT_COMPARABLE` 拒绝；无 Direct 分数或调用。
- Sealed：未进入；body read=0，Provider call=0。

### Case 3

- Calibration：passed；median=`96.125 / 57.625 / 5`；`2/2/0`；schema repair=0；Token=`2306/1499`。
- Adaptive canonical：`no_valid_child`；train elite=`s0-anchor`，score=15；`25/25/0`；schema repair=0；Token=`50607/10806`；elapsed=`101287 ms`。
- Public-select 第一次尝试：`16/16/0` 后收到 HTTP 200 empty content，正确归类 `SEMANTIC_JUDGE_PROVIDER_FAILED`；它不是 schema-repair 条件。
- 依照冻结规则只执行一次 hash-bound public-select resume；Adaptive/mutation/repair 新调用=0；resume=`18/18/0`，schema repair=0；Token=`20192/6904`。
- Public 候选：
  - B0=19，五维=`4.17 / 15 / 58.33 / 75 / 0`；comparison=false。
  - S0=19，五维=`21.39 / 25.28 / 50 / 72.5 / 0`；comparison=false。
  - evolved 未进入 terminal shortlist。
- 终局：`not_comparable / no_comparison_baseline`；Starting Reference=null；champion=null。
- Direct：正式 execute 入口在 Provider 前以 `DIRECT_RUN_NOT_COMPARABLE` 拒绝；无 Direct 分数或调用。
- Sealed：未进入；body read=0，Provider call=0。

Case 3 在产物校验修复前有一次已完成 Provider 工作但未形成 artifact 的 Adaptive 尝试（控制台 `26/26/0`）；修复后只重跑失败阶段。该 superseded 尝试和首次 public-select 失败已按最终单槽清理规则删除；其 Token 总量未保留，不能补零或推算。

## 6. Canonical artifact SHA-256

| Case | Calibration | Adaptive | Public-select |
|---|---|---|---|
| 1 | `39a22596bb2166f32e5189f48af70bc06584885b7f6324521dd8259878f757be` | `b6bf3578fd9fb7d8c745328ad711d8ea9d4c6487dd7b9b103cee38669a209594` | `e7388a27bf9f3228b43516a8ad42214406851bfb685f54d28b5ceb909b46fbd4` |
| 2 | `ebe386a9e733e7a786694c6502d051383cc5a5df0b6f4d7bb65af47715a9e5c9` | `38d7426dd9e402e2caf697a015528b4a2592ab50dcfbab5f9d09a366cb8a13ac` | `503430d265016fe742df16d081c1e7d919f5996f9a3590b8c833c1a059d96745` |
| 3 | `6e6c31f72658cbc966c9aade9c6b63e488244bc6656f0ad79b352be73f80cbf7` | `2bfd3d439a76244172f4134636b1e59a9e146fcdc76e789a2d975265528a9810` | `b3e38a18a9470d7ef1e75ed238f91efdd4b6b237409758c31bbdd583139c6f2e` |

Canonical 私有路径均为：

`projects/v3.2-u1-value-validation/<current-v3-case>/current-v3-v1/formal-evidence/adaptive/`

每案只保留：`calibration-evidence.json`、`adaptive-result.json`、`adaptive-events.jsonl`、`public-selection-result.json`。没有 Direct/audit/no-entry artifact，因为比较合同在 Provider 前即不成立；公开账本记录这一拒绝，不伪造候选。

## 7. 可声明与不可声明

可声明：

- 当前唯一 U1 主链完成构建、formal human 门与三案真实 DeepSeek 运行。
- shared non-sealed schema recovery 已统一接线，并由 focused contract tests 覆盖。
- 三案都安全地返回 `not_comparable`，没有把候选低质或 Provider empty response伪装成成功。

不可声明：

- 本轮没有可比较的 Starting Reference，因此不能声明 Adaptive 优于 Original。
- Direct 没有获得合法执行资格，因此不能声明 Adaptive 优于 Direct。
- 没有 evolved champion、没有 pairwise 胜利、没有 sealed 结果。
- 三个案例不构成普遍有效性或概率优势证据；同模型 semantic judge 仍是实验限制。

效果结论：**主链形成可审计负终局，但本轮未证明 SkillFoo 的演化优化价值。**

## 8. 最终工程验证

最终验证结果在 checkpoint 前新鲜执行：

- `npm run build`：pass
- 当前 focused tests：`175 pass / 0 fail`
- `npm test`：`770 pass / 0 fail`
- `node dist/cli.js --help`：pass，仅 13 个当前命令
- `git diff --check`：pass（只有 Git 的 LF/CRLF 环境提示）
- `git fsck --full --no-dangling`：pass
- `npm pack --dry-run --json`：pass，485 files；`projects/demo/holdout/private-case/provider-artifact` 路径计数均为 0
- secret / private key / 真实本机绝对路径：0 命中；未保存 raw Provider payload；sealed body 未读取
- release/push/publish：均未执行
- `.gitignore`：用户原有单行修改保持未暂存、未提交

## 9. 2026-08-30 三层资格语义纠偏与 Case 1 正式重跑

本节是对第 5–6 节所记 Case 1 旧终局的后续事实记录，不改写旧运行历史。共享根因位于 `evaluateU1CandidateEligibility`：旧条件把已有完整 item evidence、但 semantic 因 non-final 而标记 `skipped_non_final` 的候选误写为 `evaluationComplete=false`。现行语义删除该条件；评测完整性只要求精确 item 集合和每项 evidence 存在，hard safety、comparison、champion 与 release 资格继续由各自原有门承担。scoring identity、五维权重、最低线、安全门、案例合同和人工确认均未变化。

聚焦 TDD 证据：

- RED：`npm run build` pass；`node --test dist/evaluation/u1Rubric.test.js dist/evolution/u1ScoringChain.e2e.test.js` 为 `22 pass / 2 fail`，两项都显示安全且证据完整的 `invalid_json` 被错误投影为 `evaluationComplete=false / comparisonEligible=false`。
- GREEN：同一命令为 `24 pass / 0 fail`。
- 受影响链：`u1Rubric + u1ScoringChain E2E + publicSelection + directPublicComparison + publicSelectionResume` 为 `61 pass / 0 fail`。
- 生产代码只修改 `src/evaluation/u1Rubric.ts`；没有 Case/path/score 特判，没有新增生产模块、CLI、schema 或兼容链。

旧 Case 1 真实证据先计算 SHA-256，再以 `Move-Item -LiteralPath` 移入唯一 `formal-evidence/superseded-pre-eligibility-fix/`：

- `adaptive-events.jsonl`：`34af9617737aec75cbba23cc30da2fb306f43aea7868a1904f57d8ddbeef1d3f`
- `adaptive-result.json`：`b6bf3578fd9fb7d8c745328ad711d8ea9d4c6487dd7b9b103cee38669a209594`
- `public-selection-result.json`：`e7388a27bf9f3228b43516a8ad42214406851bfb685f54d28b5ceb909b46fbd4`

校准证据 `39a22596bb2166f32e5189f48af70bc06584885b7f6324521dd8259878f757be` 保持原位并复用；未重跑 bootstrap、preflight、provider-check 或 calibration。合同 `ae8b3ab9da0a45c138024e73f66dd7053f2b9660539c319053d200a2b7faf675`、B0、S0、runtime manifest、human 2/2 和无 bypass 均未漂移。

### Case 1 新 canonical 终局

| 对象 | public-select 总分 | 五维：correctness / evidence / capability / structure / actionability | comparison / champion |
|---|---:|---|---|
| B0 `b0-reference` | 66 | `82.5 / 81.67 / 81.67 / 83.33 / 81.67` | false / false |
| S0 `s0-reference` | 80 | `80 / 81.67 / 78.33 / 83.33 / 77.5` | true / false |
| evolved `g2-exploit` | 96 | `95.83 / 94.17 / 100 / 95.83 / 91.67` | true / true |
| Direct | 99 | `99.17 / 99.17 / 100 / 100 / 99.17` | true / true |

- Adaptive：两代及 exploit/diversify 均完成；train elite=`g2-exploit`，score=95；`public_goal_met`。Anchor=`b0-anchor`、Elite=`g2-exploit`、Diversity=`b0-anchor`。一次 mutation proposer 结构恢复（`U1_EDIT_ANCHOR_NOT_UNIQUE`），不是 candidate-item 循环重跑；没有第三次尝试。
- public-select：B0 和 S0 的 `c1-s01` 都真实以 `invalid_json` 终止并严格记 0。S0 的全部 item evidence 完整、hard safety 通过，因此 `comparisonEligible=true`；它仍因 hard-contract/quality 结果 `championEligible=false`。这直接证明“完成但 0 分”不再等同于“评测未完成”。
- Starting Reference=`s0-reference`；evolved `g2-exploit` 虽总分 +16 且绝对冠军门通过，但匿名双顺序 pairwise 为 wins=2、losses=2、order agreement=66.67%，未达到稳定性门；终局为 `start_reference_retained / no_safe_candidate`，Final Public Champion 仍为 S0。
- Direct one-shot 真实进入 DeepSeek：score=99，相对 Starting Reference/Final Public Champion 均为 `higher_public_score`、delta=+19；Direct prompt boundary 明确不含 Adaptive population、lineage、failure、内部分数或 sealed。Direct 不改变已冻结的 Adaptive public 决策。
- Sealed：`holdout_not_entered`；原因是 public-select 没有形成 novel `clear_improvement`。sealed body read=0，sealed Provider call=0。release withheld，全部命令均为 `--no-release`。

调用与观察账本：

| 阶段 | logical / HTTP / transport retry | SkillFoo cache hit/miss | prompt / completion Token | elapsed |
|---|---|---|---|---|
| Adaptive | `100 / 100 / 0` | `24 / 48` | `195520 / 35896` | `169504 ms` |
| public-select | `35 / 35 / 0` | `0 / 35` | `57457 / 11233` | `71484 ms`（由 Adaptive run_end 与 public artifact createdAt 的绑定时间差） |
| Direct | `10 / 10 / 0` | `0 / 10` | `14083 / 4093` | `21409 ms` |

本次新增真实 Provider 工作合计 `145 logical / 145 HTTP / 0 transport retry`，Token=`267060 prompt / 51222 completion`。Token 策略仍为 provider-default/observe-only；项目不维护价格表，产物没有货币 cost 字段，因此不补算或伪造货币成本。

新 canonical SHA-256：

- Adaptive events：`38d801418c7f3157a802d63356b153d207b82497dcc126d69d41ea30089e57d6`
- Adaptive result：`d247e8dd24f2d5426096c948d5df582ebfb9a4e47f7d613ea52bcfaa492fb7e2`
- public-select：`3b848cc71b4b1853099db4444a90bad5474e71916b9152d27fcda69b0ec1bfe2`
- Direct candidate：`114e65696ed8c96f623b138a473d4e08fcd33c3f8c0caea24809876b19a7d10a`
- Direct result：`631ccb8b844c2199999569910d382360a1d20cb2517f07c98592003dbf52898c`

效果解释：三层资格与 Direct 主链已经恢复；本案没有形成最终 Adaptive 新冠军，正确保留 S0。Direct 的公共集结果更高，但它是独立观察对照，不会事后替换 public-select 决策。本单案例不能证明普遍优化有效。

## 10. 2026-08-30 匿名双顺序 pairwise 诊断化与 Case 1 重跑

本节是第 9 节 Case 1 终局之后的后续事实记录，不改写旧 pairwise 硬门运行历史。通用选择规则已原地收敛为：匿名双顺序 pairwise 继续覆盖完整 terminal public-select item 集，保留 wins、losses、orderAgreement 与脱敏 request fingerprint，但只作为同模型顺序敏感性诊断；distinct、`championEligible=true` 且相对 Starting Reference `scoreDelta>=3` 的最佳挑战者必须形成 `clear_improvement`。严格 JSON、deterministic verifier、hard contract、五维最低线、安全、能力、红线和 critical regression 仍是冠军硬门。scoring identity、案例合同、B0/S0、Task Card、人工确认、动态预算和 Provider 配置均未修改。

聚焦 TDD 与受影响链证据：

- RED：`npm run build` 通过；`publicSelection + publicSelectionResume + u1ScoringChain E2E` 为 `28 pass / 3 fail`。失败分别证明旧 selector 仍返回 retained/uncertain、旧 artifact relation 仍要求 pairwise 门槛、整链仍回滚合格大幅提分挑战者。
- GREEN：同一组为 `31 pass / 0 fail`。
- 受影响链：`publicSelection + publicSelectionResume + u1ScoringChain E2E + directPublicComparison + u1SealedAudit + suiteReport + CLI entrypoint` 为 `67 pass / 0 fail`。
- 旧 Case 1 public artifact 在移动前由当前 `PublicSelectionResultArtifactSchema` 校验，因“存在 championEligible 且 delta>=3 的最佳挑战者却保留 Starting Reference”被拒绝；它不能再进入当前 Direct、sealed 或 suite report。
- 没有新增生产模块、CLI 命令、artifact/scoring/contract 版本、兼容 reader 或 Case/path/hash/score 特判。

旧硬门真实证据先计算 SHA-256，再以 `Move-Item -LiteralPath` 移入唯一固定目录 `formal-evidence/superseded-pairwise-hard-gate/`：

- `adaptive-events.jsonl`：`38d801418c7f3157a802d63356b153d207b82497dcc126d69d41ea30089e57d6`
- `adaptive-result.json`：`d247e8dd24f2d5426096c948d5df582ebfb9a4e47f7d613ea52bcfaa492fb7e2`
- `public-selection-result.json`：`3b848cc71b4b1853099db4444a90bad5474e71916b9152d27fcda69b0ec1bfe2`
- `direct-result.json`：`631ccb8b844c2199999569910d382360a1d20cb2517f07c98592003dbf52898c`
- `direct-candidate.v1.json`：`114e65696ed8c96f623b138a473d4e08fcd33c3f8c0caea24809876b19a7d10a`

校准证据 `39a22596bb2166f32e5189f48af70bc06584885b7f6324521dd8259878f757be` 保持原位并复用；没有重跑 bootstrap、preflight、provider-check 或 calibration。合同 `ae8b3ab9da0a45c138024e73f66dd7053f2b9660539c319053d200a2b7faf675`、B0 `a41d0162fa52766d93204bf22f46564e09cd2cf14bca6e7d7f1787e0162edf64`、S0 `0bbf3f6d106ee48ad21771c5d0d765a5656268d6c89cef20e5d667d08982de22`、runtime manifest `c938b1b82a1e5b6ed130a80a33eab61c08e90691f10ce02f0725b79024c8ea39`、human 2/2 和无 bypass 均未漂移。

### Case 1 新 public 终局

| 对象 | public-select 总分 | 五维：correctness / evidence / capability / structure / actionability | comparison / champion |
|---|---:|---|---|
| B0 `b0-reference` | 65 | `80 / 80.83 / 83.33 / 83.33 / 77.5` | false / false |
| S0 `s0-reference` | 80 | `78.33 / 79.17 / 83.33 / 82.5 / 75.83` | true / false |
| evolved `g2-diversify` | 65 | `63.33 / 66.67 / 66.67 / 66.67 / 65` | true / false |
| evolved `g1-exploit` | 94 | `93.33 / 95.83 / 100 / 100 / 73.33` | true / true |

- Adaptive：两代及 exploit/diversify 均完成，停止原因为 `public_goal_met`；train elite=`g2-diversify`，score=98；最终 population 为 Anchor=`b0-anchor`、Elite=`g2-diversify`、Diversity=`g1-exploit`。一次 mutation structure recovery，未发生第三次 application attempt。
- terminal public-select：Starting Reference=`s0-reference`；Final Public Champion=`g1-exploit`；`scoreDelta=+14`；verdict=`clear_improvement`。Pairwise 诊断为 wins=3、losses=1、orderAgreement=`4/6=66.67%`，完整覆盖 6 个冻结 select item；低一致率被保留为诊断，但没有否决已通过全部冠军硬门的挑战者。`feedbackToEvolution=false`。
- `g1-exploit` 的 actionability 从 Starting Reference 的 75.83 降到 73.33，但仍高于 60，且没有 hard/critical regression；现行 scoring identity 不把这一小幅、仍过线的 protected dimension 下降当成绝对硬回滚。
- Direct one-shot 真实进入 DeepSeek，产生 `1 logical / 1 HTTP / 0 transport retry`；候选随后被确定性 capability gate 以 `DIRECT_U1_BOUNDARY_VIOLATION` 拒绝（`network:execution_instruction`）。这是 `candidate_rejected` 的可审计 Direct 终局，不伪造 0 分，也不修改已冻结 public champion。

调用与观察账本：

| 阶段 | logical / HTTP / transport retry | SkillFoo cache hit / miss | application recovery | prompt / completion Token | elapsed |
|---|---|---|---:|---|---|
| Adaptive | `98 / 98 / 0` | `24 / 48` | 1 | `174475 / 36590` | `169306 ms` |
| public-select | `45 / 45 / 0` | `0 / 45` | 0 | `72580 / 14025` | 已记录于同一 Adaptive canonical run |
| Direct | `1 / 1 / 0` | `0 / 1` | 0 | `593 / 650` | 控制台 `5870 ms` |

本次新增真实 Provider 工作合计 `144 logical / 144 HTTP / 0 transport retry`，Token=`247648 prompt / 51265 completion`。Token 策略仍为 provider-default/observe-only；没有价格表或可审计货币 cost 字段，因此不补算货币成本。

新 canonical SHA-256：

- Adaptive events：`3047064e44bcea1b3a5edf58cba4519102c55c27fa623fb2a9829cccb8f81743`
- Adaptive result：`0a64c31f75af1ee150ec88390da6e7239606b3eaf1082ecd1758ecac97196772`
- public-select：`568c6b7b1e2d5fb882575e44603fa4f29a74831cd465f881f9ca5fa520960a53`
- Direct result：`62f760e95c293b002c5708a0f45bd291b8ed9b07775771952afc9c9f033b7e1d`
- Direct candidate 没有 canonical artifact：候选在 capability gate 被拒绝，旧 `direct-candidate.v1.json` 只存在于上述 superseded 归档。

### Conditional sealed 阻断

public verdict 为 `clear_improvement` 且 Direct result 已形成后，按授权只执行了一次 `audit-compare --execute --no-release`。入口在读取 holdout 或发起 Provider 调用之前，以 `AUDIT_COMPARE_U1_CANDIDATE_BINDING_INVALID` fail-closed；没有创建 audit artifact。最小复现是 public decision 的 Starting Reference ID 为 `s0-reference`，而 frozen Adaptive candidate table 中相同 S0 字节的 ID 为 `s0-scaffold`。入口当前先按 ID 在 Adaptive candidate table 查找，再验证 SHA-256，因此 Starting Reference 查找为空；S0 字节哈希本身仍一致。该 ID namespace 绑定问题不是本次 pairwise 决策改动直接造成的，依照任务停止线未修复、未重试、未扩张范围。

此外，Direct 虽形成了严格绑定的 `direct-result.json`，但候选被 capability gate 拒绝，因而没有新的 canonical `direct-candidate.v1.json`，B4 候选本身并不完整。即使绕过上述根 ID 别名缺陷，sealed 也应继续 fail-closed/不进入；本任务没有复用归档中的旧 Direct candidate，也没有拼接新旧证据。

Sealed 状态：body read=0、Provider logical/HTTP=0、application/schema recovery=0、无第二次 audit、无反馈、release withheld。全部真实命令均为 `--no-release`；没有 push、publish 或 release。

最终判定：pairwise 已成功降级为完整、可重算的同模型诊断，且新的 public 规则在真实 Case 1 中选出符合硬门、delta=+14 的新冠军；Direct 也真实执行并诚实拒绝越界候选。但 conditional sealed 被上述计划外候选 ID 绑定缺陷阻断，因此本任务按“存在明确阻断，停止，不扩大修复”封账，不能据此进入 Case 2，也不能声称完整 Case 1 sealed 终局或普遍优化有效。

## 11. 2026-08-30 Pairwise 当前架构物理删除

本节只记录当前代码和合同清理，不改写第 9–10 节真实运行历史。匿名双顺序 Pairwise 已从活跃 public-select 实现、结果 schema、resume 关系校验、动态预算、CLI、Direct、suite report、README、U1 合同和活跃测试中物理删除；没有增加替代 judge、可选模式、兼容 reader、迁移器、schema 版本或新治理机制。

当前 public-select 规则为：B0/S0 中选择 `comparisonEligible` 且得分较高的根作为 Starting Reference（同分保留 B0）；不同哈希且通过全部 `championEligible` 硬门的挑战者按 public weighted mean 降序、同分按稳定哈希顺序选择最佳者；最佳者 `scoreDelta>=3` 时形成 `clear_improvement`，否则保留 Starting Reference。新的 public 固定调用公式为 `shortlistCandidates * ceil(selectItems / semanticBatchSize)`；candidate-item 动态容量、单次循环恢复、semantic schema recovery、Direct/sealed 独立预算和 sealed one-shot 均未改变。

验证事实：

- `npm run build`：通过。
- 规定聚焦回归：`75 pass / 0 fail`。
- `npm test`：`769 pass / 0 fail`。
- 只读终审发现 selection/decision/candidate 子对象仍会默认剥离未知字段，并且无合格新挑战者的 `candidate_rejected` 关系尚未完全 fail-closed；在同一允许文件内收紧现有 schema、补齐原选择语义后，受影响链复核为 `59 pass / 0 fail`。没有增加旧字段兼容或新资格链。
- 活跃源码、编译产物、README 与 U1 合同的 Pairwise 专属符号扫描：0 命中。
- public-select/resume/CLI/suite report 的 `wins/losses/firstOrder/swappedOrder` 扫描：0 命中。
- 历史目录 `formal-evidence/superseded-pairwise-hard-gate/` 仍为 5 个普通文件；结束时文件名和 SHA-256 与任务开始时逐项一致。
- 锁定的 `.gitignore`、`src/evaluation/u1Rubric.ts`、`src/evaluation/u1Rubric.test.ts` SHA-256 均未漂移。
- 本次 Provider logical/HTTP calls=`0/0`；未运行 Case 1–3，未读取 sealed，未执行 release、push 或 publish。

本节不声称 Case 1 已按无 Pairwise 的当前合同重新跑通，也未处理第 10 节记录的 sealed S0 ID namespace 绑定问题。

## 12. 2026-08-30 sealed 哈希绑定定点修复与无 Pairwise 三案串行运行

本轮先修复第 10 节记录的 sealed 候选命名空间绑定缺陷，再按低、中、高顺序执行当前无 Pairwise 主链。修复没有改动评分、合同、案例、runtime、Direct、sealed one-shot 或人工门禁：public candidate ID 继续作为报告标签；`audit-compare` 改以 public evaluation 的冻结 `skillSha256` 在 Adaptive candidate table 中解析真实字节，exact ID 且 hash 正确时优先，否则按 candidateId 稳定选择同哈希候选；无 hash 匹配仍以 `AUDIT_COMPARE_U1_CANDIDATE_BINDING_INVALID` fail-closed。实际 candidate source 记录解析到的 Adaptive ID，不存在 `s0-reference -> s0-scaffold` 别名表。

聚焦 TDD 仅用于该确定性 sealed 边界：

- RED：`npm run build` 通过；`node --test dist/evolution/u1SealedAudit.test.js` 为 `21 pass / 1 fail`，失败是公共 ID 与 Adaptive ID 不同、字节 hash 相同时共享解析函数缺失（`actual=undefined`, `expected=function`）。
- GREEN：`npm run build` 通过；`node --test dist/evolution/u1SealedAudit.test.js dist/tests/u1FormalCli.test.js` 为 `30 pass / 0 fail`。
- 修改范围只有 `src/evolution/u1SealedAudit.ts`、`src/cli.ts`、`src/evolution/u1SealedAudit.test.ts`；没有新生产模块、命令、schema、兼容 reader、Case 特判或 holdout/Provider 测试调用。

### 旧运行证据归档

每案运行前均解析并验证绝对路径位于对应 Case 根内；下列旧运行文件先计算 SHA-256，再以 `Move-Item -LiteralPath` 移入各案唯一固定目录 `formal-evidence/superseded-pre-pairwise-removal/`。calibration、冻结输入、合同、Task Card、human 2/2、runtime 与 holdout 均保持原位。

- Case 1：`adaptive-events.jsonl`=`3047064e44bcea1b3a5edf58cba4519102c55c27fa623fb2a9829cccb8f81743`；`adaptive-result.json`=`0a64c31f75af1ee150ec88390da6e7239606b3eaf1082ecd1758ecac97196772`；`public-selection-result.json`=`568c6b7b1e2d5fb882575e44603fa4f29a74831cd465f881f9ca5fa520960a53`；`direct-result.json`=`62f760e95c293b002c5708a0f45bd291b8ed9b07775771952afc9c9f033b7e1d`。
- Case 2：`adaptive-events.jsonl`=`7b9b669db090ffbe1b0e326f2bb202e2977bf10c019c03778bc3620c3a02645f`；`adaptive-result.json`=`38d7426dd9e402e2caf697a015528b4a2592ab50dcfbab5f9d09a366cb8a13ac`；`public-selection-result.json`=`503430d265016fe742df16d081c1e7d919f5996f9a3590b8c833c1a059d96745`。
- Case 3：`adaptive-events.jsonl`=`078a9b444b730d71fab040d0c7639fbf6f11220a95bd2060f91501ff3e992934`；`adaptive-result.json`=`2bfd3d439a76244172f4134636b1e59a9e146fcdc76e789a2d975265528a9810`；`public-selection-result.json`=`b3e38a18a9470d7ef1e75ed238f91efdd4b6b237409758c31bbdd583139c6f2e`。

### Case 1（低质量）正常终局

合同=`ae8b3ab9da0a45c138024e73f66dd7053f2b9660539c319053d200a2b7faf675`，复用已绑定 calibration；未重跑 bootstrap、preflight、provider-check 或 calibration。

| 对象 | public-select 总分 | 五维：correctness / evidence / capability / structure / actionability | comparison / champion |
|---|---:|---|---|
| B0 `b0-reference` | 96 | `97.83 / 93.83 / 96.67 / 100 / 92` | true / true |
| S0 `s0-reference` | 81 | `80 / 80 / 83.33 / 83.33 / 79.17` | true / false |
| Direct | 77 | `76.67 / 78.33 / 75 / 83.33 / 75` | true / false |

- Adaptive：`no_valid_child`；Anchor/Elite=`b0-anchor`、Diversity=`s0-scaffold`；generation 1 的 exploit/diversify 均为 `no_change`，没有重复评测；train Elite=84。
- public-select：Starting Reference=`b0-reference`，Final Public Champion=`b0-reference`，`start_reference_retained`，delta=0；无 Pairwise 字段。
- Direct one-shot：真实执行，严格冠军门未过，`candidate_rejected`，相对起点 delta=-19。
- sealed：执行 no-entry 分支，`holdout_not_entered/no_novel_public_champion`，bodyReads=0、Provider calls=0、release withheld。

| 阶段 | logical / HTTP / transport retry | cache hit / miss | application recovery | prompt / completion Token | elapsed |
|---|---|---|---:|---|---|
| Adaptive | `33 / 33 / 0` | `0 / 16` | 0 | `58201 / 9615` | `53838 ms` |
| public-select | `22 / 22 / 0` | `0 / 22` | 0 | `33709 / 7022` | 同一 Adaptive canonical run |
| Direct | `11 / 11 / 0` | `0 / 11` | 0 | `13822 / 3853` | 本轮命令内完成 |

canonical SHA-256：events=`e59ac5defdd501c7641a0388d264432a01bb94268d35d9a151d992a89ff11d7d`；Adaptive=`bfb33f5ecc608591a28cafbfe441cf61564f21ef443858c4fe3c1310cd5d3325`；public=`e10c4566b235370bb2a36856a5519e094957064fedcf3fcb19e908a455029781`；Direct=`6a09e59a1635ae204749feda42139f344378daa7bcaa1aafcb25f4d5e0433c82`；no-entry=`0496c9e7daf324d7437a1888ff5e1b367c610babcb863679159b6b596d742bea`。

### Case 2（中质量）正常终局

合同=`0fea1f8bcd4d9720e877e6ea738b9bb6a7c5fe6afad38f25759ad910ab76bf9c`，复用已绑定 calibration。

| 对象 | public-select 总分 | 五维：correctness / evidence / capability / structure / actionability | comparison / champion |
|---|---:|---|---|
| B0 `b0-reference` | 31 | `40 / 16.67 / 0 / 92.5 / 47.5` | true / false |
| S0 `s0-reference` | 11 | `6.67 / 6.67 / 8.33 / 79.17 / 11.11` | true / false |
| evolved `g1-diversify` | 61 | `77.83 / 78.67 / 67.5 / 75 / 76.17` | true / false |

- Adaptive：两代 exploit/diversify 全部实际执行，`public_goal_met`；Anchor=`s0-anchor`、Elite=`g1-diversify`、Diversity 空（无不同 hash 的安全互补候选）；train Elite=93；一次既有结构恢复。
- public-select：Starting Reference=`b0-reference`，Final Public Champion=`b0-reference`，`start_reference_retained/no_safe_candidate`。最佳新候选 public delta=+30，但 deterministic judging gate 未过，因此仍无冠军资格；无 Pairwise 字段。
- Direct one-shot：真实进入 Provider 后被 deterministic capability gate 拒绝（`DIRECT_U1_BOUNDARY_VIOLATION`），`1 logical / 1 HTTP / 0 retry`；semantic=`not_run`，numeric=`not_comparable`，未伪造分数。
- sealed：执行 no-entry 分支，bodyReads=0、Provider calls=0、release withheld。

| 阶段 | logical / HTTP / transport retry | cache hit / miss | application recovery | prompt / completion Token | elapsed |
|---|---|---|---:|---|---|
| Adaptive | `81 / 81 / 0` | `18 / 38` | 1 | `187693 / 34728` | `221717 ms` |
| public-select | `34 / 34 / 0` | `0 / 34` | 0 | `58164 / 12564` | 同一 Adaptive canonical run |
| Direct | `1 / 1 / 0` | `0 / 1` | 0 | `1100 / 1715` | 本轮命令内完成 |

canonical SHA-256：events=`83808dac28051a3e41b99dea9750b7c3212ec0e77ddc60e3c1bfcf6afb756623`；Adaptive=`38bd1b050d93158be1d2d627e905a0d16df3f2fd7a328fc221260c4f9caed82f`；public=`c02424daf6c5b6ae9906fa043c61380b67e5a152b92d54dd28dfd41acf8ed6bd`；Direct=`420d21365232bfb752da0105de1cfac8361efde22181a8285d24cecfe9cefddf`；no-entry=`3884528cb4bd3b011b2ccde458d91b2ad1ad8d64d40508fb62bd4d1877c9049c`。

### Case 3（高质量）共享主链阻断

合同=`62185962666fa66525d53fa6ec093ff7cbdf9f2317ce459eb2258c3dede96f16`，human 2/2、runtime、B0/S0 和 calibration 均在调用前绑定通过。唯一 Adaptive 运行在 generation 2 的 proposer 恢复路径后返回 `stopReason="proposer_failure"`；`runAdaptive` 的正式结果类型允许该值，但 `parseAdaptiveResultArtifact` 使用的 `AdaptiveResumeArtifactSchema` 只接受 `public_goal_met | generations_completed | stagnation_stop | no_valid_child`。结果在 canonical writer 前被 Zod 拒绝；该错误又不属于 CLI 现有会写 `adaptive-failure.json` 的 Provider/budget/semantic/scenario catch 集，因此目录只剩 calibration，没有 Adaptive result、events 或脱敏 failure artifact。

- 失败前观察账本：`43 logical / 43 HTTP / 0 transport retry`，generation 1 exploit/diversify 已完成，generation 2 进入既有 structure recovery；最终 Token、cache 与恢复汇总因结果/失败 writer 均未形成而不可审计，未补零或估算。
- 这是 current schema 接线错误，不是候选低分、Provider 身份错误、预算耗尽或 sealed 哈希绑定复发；依照停止线未修改代码、未运行 Case 3 Direct、未调用 audit-compare、未读取 holdout，也未继续生成 suite manifest/report。

本轮在停止前合计真实 Provider=`225 logical / 225 HTTP / 0 transport retry`。可审计 Token 仅覆盖 Case 1/2：`352689 prompt / 69497 completion`；Case 3 Token 未持久化，货币成本也无项目内价格来源，故不补算。三案均未进入 sealed body，全部命令保持 `--no-release`；无 push、publish 或 release。

最终判定：sealed 的公共标签/Adaptive 字节 hash 绑定缺陷已按通用规则修复并通过聚焦验证；Case 1/2 的无 Pairwise Adaptive→public-select→Direct→no-entry 主链正常，均保留 Starting Reference，本轮未观察到合格 evolved champion。Case 3 暴露上述新的共享结果 schema/writer 阻断，因此本任务在此停止；不能生成三案 suite report，也不能声称三案例全部完成或当前三案已证明优化价值。

## 13. 2026-08-30 Adaptive 终止状态链纠偏与三案合同重建（第二确认前）

本节记录本轮重建前的旧活动证据和确定性接线修复；第 12 节的真实运行事实保持原样。入口 HEAD 为 `960aad29ba6186f5869d48f43c6cb4e7f4ba52e7`，工作树已有合法未提交成果和用户自己的 `.gitignore` 修改，均未 reset、checkout、clean、commit、push 或 release。

旧生产链的根因是 producer 与 consumer 维护了不一致的终止状态：`runAdaptive` 可以返回八种结构化状态，但成功 artifact parser 只接受四种可比较状态，CLI 又在分流前无条件调用该 parser。Case 3 已真实返回 `proposer_failure`，却在 canonical writer 前被 Zod 拒绝；该错误也不属于原 runtime-error writer 的捕获集合，所以在 `43 logical / 43 HTTP / 0 transport retry` 后既没有 `adaptive-result.json`，也没有 `adaptive-failure.json`。

现行唯一分类为：

- 可继续比较：`public_goal_met`、`generations_completed`、`stagnation_stop`、`no_valid_child`；
- 必须落盘为可审计失败：`proposer_failure`、`safety_kill`、`budget_exhausted`、`root_rebuild`。

`src/evolution/publicSelectionResume.ts` 现在提供同一张穷尽映射和共享 schema；`src/cli.ts` 在任何成功 parser、public-select、Direct 或 sealed 之前分流结构化失败，并复用现有 `adaptive-failure.json` 通道。失败 artifact 只保存稳定错误码、失败终止原因、logical/HTTP/retry/cache/token/accounting、elapsed 与 `{at,type}` 脱敏事件，不保存 stopDetail、原始 Provider 正文、prompt、API key 或 sealed 内容。sealed 元数据也复用同一可比较状态 schema，不再独自维护漏掉 `no_valid_child` 的旧三项枚举。

聚焦 TDD 仅用于该确定性边界：

- RED：build 通过；`publicSelectionResume + u1FormalCli` 为 `13 pass / 2 fail`，分别证明共享八状态分类和结构化失败 writer 尚不存在；
- GREEN：build 通过；同组为 `15 pass / 0 fail`；fake `proposer_failure` 只生成一个脱敏 `adaptive-failure.json`，不生成伪成功或后续阶段产物。

准备失效并重建的三套旧活动合同如下；低/中/高只描述冻结输入来源，不由旧分数定义：

| Case | 旧 contract identity | 旧最终状态 | 旧主要结论/失败 |
|---|---|---|---|
| Case 1 controlled-degradation | `ae8b3ab9da0a45c138024e73f66dd7053f2b9660539c319053d200a2b7faf675` | `no_valid_child` | B0=96、S0=81，保留 B0；Direct=77；sealed body read=0 |
| Case 2 medium-derivation | `0fea1f8bcd4d9720e877e6ea738b9bb6a7c5fe6afad38f25759ad910ab76bf9c` | `public_goal_met` | B0=31、S0=11、最佳 evolved=61 但无冠军资格；保留 B0；Direct capability rejected；sealed body read=0 |
| Case 3 high-untouched | `62185962666fa66525d53fa6ec093ff7cbdf9f2317ce459eb2258c3dede96f16` | `proposer_failure` | 43 次真实调用后触发上述 writer 接线缺陷；无 canonical result/failure；未进入 Direct/sealed |

合同审计还确认旧 Case 1/2 公开题面普遍暴露精确 JSON key、工具名或 logical ID，Case 2 另有上游未定义的隐藏 `execution_status=not_executed` 规则；train/select 虽无精确字符串交叉，却存在成对近义模板。它们将连同 Case 3 一起作废重建，不与新合同分数直接比较。

每案保留：根目录 `b0-source/SKILL.md`、来源/派生 manifest、`intake-input.json`、内容未变的 `task-card.confirmed.json` 及第一次真实人工确认、`runtime-context/`。每案将精确删除并重建根目录的 `evaluation-blueprint.json`、`evaluation-draft.json`、`evaluation-curation.json`、`evaluation-review.draft.json`、`evaluation-review.zh-CN.md` 和整个旧 `formal-evidence/`；不建立 old/new 双活动 lane，不复制旧 holdout。新 evaluation review 形成后必须重新等待第二次真实人工确认，确认前 Provider calls 保持 `0`。

旧三案活动 `formal-evidence/` 已逐案校验绝对路径、父目录和非 reparse 属性后移入 Windows 回收站；旧根目录 evaluation blueprint/draft/curation/review 也按精确路径移入回收站。该操作可恢复，且没有创建 `old`、时间戳备份或第二条活动 lane。B0、来源/派生 manifest、Task Card/第一次 human 确认、runtime context 均保留，旧结果摘要和旧合同 identity 继续保留在本 ledger。旧 sealed 正文未被读取或复制。

三套新合同均由已确认 Task Card、冻结 Skill 行为与 capability/redline 边界在任何候选运行前重新撰写；公开题面使用自然业务请求，不包含 JSON key、评分/门禁术语、工具名、logical ID、`reference.read` 或答案提示。一次性 OS 临时作者脚本已删除。第一次机器 curation 后，独立只读语义审计发现 train/select 近邻和 Case 3 非触发题提示过强；相关题面已在确认前直接替换，所有旧 review hash 因内容变化作废，没有保留双合同。最终 curation 和 sealed-safe 复审事实如下：

| Case | 来源性质 | train/select/holdout | critical | curation | public 泄漏 / rule trace / redline | Task Card hash | 最终 evaluation review hash | review document hash |
|---|---|---:|---:|---|---|---|---|---|
| Case 1 | source-grounded + controlled-degradation | `8/6/3` | 4 | `accepted`, 0 findings, medium 60 | `0 / 0 / 6/6` | `22560228651f2818b129de39b700f32d29ca234c0f62faa9020549c7b0efc62f` | `bcb0f1c08628c17fc6cbf25407993afc0eea45ddce0ab4bc2c13113cd8126115` | `c815a3cf9d0b8a817ee97cfcecea9362590ef7d549c0e3208ef1b99c62a6e5cb` |
| Case 2 | source-grounded + medium-derivation | `8/6/3` | 4 | `accepted`, 0 findings, medium 60 | `0 / 0 / 6/6` | `ed68a45e521655cd3cf2650aa1a078fab06e62756bb28534fd5bf0746e1014d2` | `43e8bf8d3aabed27a01069f181c747d152296893430a78816b406ab42a343c10` | `722632e238edba9b76e6b6c74671e62769a44d514787966a207dbb4dd3f43431` |
| Case 3 | source-grounded + high-untouched | `8/6/3` | 5 | `accepted`, 0 findings, medium 60 | `0 / 0 / 6/6` | `37a26445c1b2ed6e80377845ab856f58bbee9a3583d3c47efff979c526197a33` | `079f7416a7c46f32ae1278881b40501dab1429a3945a5bd0db431da774cde0ab` | `30a5e4f2e4cd5be28002d990650b5048365a7abdfe109adc6d48c32e231c13b8` |

每案 itemId、scenarioId、scenarioFamily 和归一化输入均唯一；train/select 近邻经过人工语义复审后已拉开。普通内容完整性只保留题面明确出现的最小 `quality` evidence；真实 reference 成功轨迹继续是 runtime/Task Card/B0 可追溯的 `hard_contract`。严格外层 JSON、五维/60 分线、hard safety、能力白名单和现有 scoring identity 未修改；Pairwise 未恢复。新 holdout 从 Task Card/来源重新撰写，未读取或照抄旧 sealed 正文，正文未进入本摘要、candidate 或 Provider。

当前状态为 `waiting_human`：三份 Task Card 第一次确认仍为既有 `confirmed/human`，三份 evaluation review 均为 `draft`，尚未创建第二次确认。当前没有 `formal-evidence/`、bootstrap、calibration 或运行产物；本轮 Provider logical/HTTP=`0/0`，未 freeze、未进入 Direct/sealed、未 release、未 commit、未 push。只有收到用户针对上述最终 review hash 的新鲜第二次确认后，才允许进入 eval-freeze、bootstrap、零网络预检和真实三案运行。

## 14. 2026-08-31 重建合同确认、终止状态纠偏验证与三案真实终局

用户在当前对话中分别确认三份第 13 节最终 evaluation review；CLI 仅机械代录用户提供的身份文本，本 ledger 不复制身份值。三份公开 `human` approval SHA-256 分别为：Case 1 `234419ff1697f12c85b51ab6fe2c3e0a9e9f074cf017ab3bd8109c5e3dd5a640`、Case 2 `a62c4fac005114b7276bd5593f2d98d2a72950e17a0da7356f38c786a3c11cc6`、Case 3 `bca5654d34ca673b443004208bdf35ddf4d5f69336d103709faf523b9c4add00`。三案均为 human 2/2、`humanConfirmationBypassed=false`，没有 development/test-fixture 旁路。

新正式冻结绑定：

| Case | contract SHA-256 | B0 SKILL.md | S0 SKILL.md | runtime manifest |
|---|---|---|---|---|
| Case 1 低质量 controlled-degradation | `85eca89c09cb7b487531b0c16011d74ad0d15d1ccffbd7d296e481d01bcacf91` | `a41d0162fa52766d93204bf22f46564e09cd2cf14bca6e7d7f1787e0162edf64` | `0bbf3f6d106ee48ad21771c5d0d765a5656268d6c89cef20e5d667d08982de22` | `c938b1b82a1e5b6ed130a80a33eab61c08e90691f10ce02f0725b79024c8ea39` |
| Case 2 中质量 medium-derivation | `d434d9df4b1bdd289bbaa7865eaac7c28221577843ef492480bce6695431417a` | `952decea5c72b614330f41f30e6159b2c57dcf902b2f724e7fbcf62e2d7f3ab6` | `2878118df4754ea56e4be9709363d45734f5d02ff5ccada735e8c8f29c2d87eb` | `c938b1b82a1e5b6ed130a80a33eab61c08e90691f10ce02f0725b79024c8ea39` |
| Case 3 高质量 high-untouched | `4feeb04c7212d8d019b41d469554bc88300a0dc5fc6ec8fd3aea0867bcde7d97` | `e2587a303205083c1d05ae2181048d7b795420c9d2a9ed0873cfcebe1f261bd5` | `1756f8a93550a01342af5d8c648f47f0f0a8e9f423efb0819bd6df5683f10b6c` | `7c0319f5a02fe1a60c016820dad7f3486c98e2c72ac86237d7ec3b78bc99adda` |

bootstrap 的 formal B0 与根 B0 字节一致；S0 扫描未发现 contract hash、gate、split、holdout、judgingRule、expectedOutcome、本机路径或隐藏测试泄漏。三案 calibration/Adaptive/Direct 的零网络 preflight 均确认 `deepseek-v4-flash`、provider-default/observe-only Token、动态 `M=2`、human 2/2、sealed unopened 和 side effects=none。没有重复 provider-check。

### Case 1 低质量：正常保留 B0

Calibration 两个 primary pass 直接通过：`2 logical / 2 HTTP / 0 retry / 0 schema repair`。

| public-select 对象 | 总分 | 五维：correctness / evidence / capability / structure / actionability | comparison / champion |
|---|---:|---|---|
| B0 `b0-reference` | 87 | `77 / 90.33 / 93.83 / 91.5 / 92.5` | true / true |
| S0 `s0-reference` | 81 | `60 / 92.5 / 96.67 / 90 / 85.83` | true / true |
| evolved `g1-exploit` | 54 | `43.33 / 59.17 / 62.5 / 60.83 / 57.5` | true / false |
| Direct | 85 | `74.5 / 87.83 / 95 / 92.83 / 88.67` | true / true |

- Adaptive 完成两代并以 `stagnation_stop` 正常进入 public-select；Anchor/Elite=`b0-anchor`，Diversity=`g1-exploit`。train 分数：B0=84、S0=40、g1-exploit=57、g1-diversify=46、g2-exploit=25。
- evolved 的两个 invalid JSON select item 继续严格记 0；候选仍可比较但无冠军资格。Starting Reference/Final Public Champion 均为 B0，verdict=`candidate_rejected`，最佳 evolved delta=`-33`。
- Direct 独立真实执行，全部门通过但相对 B0 delta=`-2`，不追溯修改 public 决策。
- sealed=`holdout_not_entered`；bodyReads=0、Provider=0、application recovery=0、release withheld。

| 阶段 | logical / HTTP / transport retry | schema/application recovery | cache hit/miss | prompt / completion Token | elapsed |
|---|---|---:|---|---|---|
| calibration | `2 / 2 / 0` | 0 | n/a | `1894 / 1474` | artifact 未保存 elapsed |
| Adaptive | `83 / 83 / 0` | 0 | `18 / 40`（run-end） | `150256 / 34024` | `226849 ms` |
| public-select | `39 / 39 / 0` | 1 次 semantic schema repair | `0 / 39` | `71480 / 18268` | artifact 未保存 elapsed |
| Direct | `14 / 14 / 0` | 0 | `0 / 14` | `24585 / 5784` | `33561 ms` |

Canonical SHA-256：events=`300e56adb5dcbe4b7e4fde0c11688d0c48a3429a929b31c43417bbe74ce07d8c`；Adaptive=`4ae1719e6582dc32358ce28eaa8bc165bd4bf35d0ef3d35d56b86d7f7158600b`；public=`df2ae2fa6e171034f0800c14301e621121b203fa7c781142ea222ab56eccf8ba`；Direct candidate=`1d4d39ae8a5f88e5c8467713281ee015a5d32882c17530f2d62e2688740bc643`；Direct result=`65faead2ba031aade20da93594358787892fac7ed405a53f0dc33356856c148f`；no-entry=`947186e54d77104cd6c142e473bf54b3eb92c8316e5e4791f22f96aa299f03df`。

### Case 2 中质量：保留 S0，Direct 硬门拒绝

Calibration pass 1 首次返回 `SEMANTIC_JUDGE_INVALID_JSON`，使用一次内容无关 schema repair 后通过；pass 2 直接通过。总计 `3 logical / 3 HTTP / 0 transport retry`，没有第三次调用。

| public-select 对象 | 总分 | 五维：correctness / evidence / capability / structure / actionability | comparison / champion |
|---|---:|---|---|
| B0 `b0-reference` | 62 | `76.67 / 77.5 / 78.33 / 75 / 76.67` | false / false |
| S0 `s0-reference` | 64 | `61.67 / 66.67 / 66.67 / 61.67 / 64.17` | true / false |
| evolved `g1-diversify` | 58 | `46.67 / 65 / 66.67 / 61.67 / 61.67` | true / false |
| Direct | 67 | `46.67 / 79.17 / 79.17 / 74.17 / 72.5` | true / false |

- `requires_s0_rebuild` 保持 B0 为只读证据，正式演化从 S0 开始。两代完成并以 `stagnation_stop` 正常进入 public-select；train Elite=`g1-diversify`（76），Anchor=`s0-anchor`，Diversity=`s0-anchor`。
- public-select Starting Reference/Final 均为 S0，verdict=`start_reference_retained`，最佳 evolved delta=`-6`。
- Direct 相对 S0 delta=`+3`，但 judging gate 未过，故 `candidate_rejected`；总分不能补偿冠军硬门。
- sealed=`holdout_not_entered`；bodyReads=0、Provider=0、release withheld。

| 阶段 | logical / HTTP / transport retry | schema/application recovery | cache hit/miss | prompt / completion Token | elapsed |
|---|---|---:|---|---|---|
| calibration | `3 / 3 / 0` | 1 | n/a | `2827 / 2010` | artifact 未保存 elapsed |
| Adaptive | `66 / 66 / 0` | 2 | `12 / 30`（run-end） | `146409 / 30984` | `238377 ms` |
| public-select | `35 / 35 / 0` | 0 | `0 / 35` | `60377 / 14305` | artifact 未保存 elapsed |
| Direct | `13 / 13 / 0` | 0 | `0 / 13` | `24103 / 6215` | `34191 ms` |

Canonical SHA-256：events=`f73fdc11b323467791eacdd0b8c6d003711c4240e6e2fc8a46f8a778824b979a`；Adaptive=`ac29eee576fa235039456eab5a22d2300d8e168d5c50076a7f578a695930b5fd`；public=`67af2d7ae292d2ced82ead2fe16e0ec3c2192e22dbd2a9454ed21223e60379b9`；Direct candidate=`a1841229c755a3ef083101985058105f5623f53824fe4dd87036c96502e3b3e7`；Direct result=`da872405e48126766ecf8a63b4d68ec14caf51b7fe3a8d0ca4da372165c44a73`；no-entry=`640b968fb3d4f647a0942834c80a9d03a233775132950af053a5a969a98c614a`。

### Case 3 高质量：`no_valid_child` 正常落盘并保留 B0

Calibration pass 2 首次发生 `SEMANTIC_JUDGE_ITEM_MISMATCH`，使用一次 schema repair 后通过；总计 `3 logical / 3 HTTP / 0 transport retry`。

| public-select 对象 | 总分 | 五维：correctness / evidence / capability / structure / actionability | comparison / champion |
|---|---:|---|---|
| B0 `b0-reference` | 74 | `74.67 / 79.5 / 64.17 / 75.5 / 73.33` | true / false |
| S0 `s0-reference` | 56 | `70.83 / 70 / 62.5 / 72.5 / 70.83` | true / false |
| Direct | 66 | `59.17 / 80.83 / 66.67 / 60.83 / 60` | true / false |

- generation 1 的 exploit/diversify 都返回 `no_change`；Adaptive 以 `no_valid_child` 结束。该状态被共享成功集合接受，`adaptive-result.json` 和 public 结果均正常形成，不再出现旧 parser 拒绝或“既无 result 又无 failure”。
- Starting Reference/Final 均为 B0，verdict=`start_reference_retained`、delta=0；没有 evolved child。
- Direct 相对 B0 delta=`-8` 且 judging gate 未过，故 `candidate_rejected`。
- sealed=`holdout_not_entered`；bodyReads=0、Provider=0、release withheld。

| 阶段 | logical / HTTP / transport retry | schema/application recovery | cache hit/miss | prompt / completion Token | elapsed |
|---|---|---:|---|---|---|
| calibration | `3 / 3 / 0` | 1 | n/a | `2937 / 1495` | artifact 未保存 elapsed |
| Adaptive | `12 / 12 / 0` | 0 | `0 / 8`（run-end） | `21562 / 5458` | `58453 ms` |
| public-select | `17 / 17 / 0` | 0 | `0 / 17` | `19721 / 7850` | artifact 未保存 elapsed |
| Direct | `10 / 10 / 0` | 0 | `0 / 10` | `16378 / 6218` | `33273 ms` |

Canonical SHA-256：events=`1e8ad1122085f9229ae3b3f6f1cfa3b5492a6f46c0a09198b9c5553a0a8efdde`；Adaptive=`547a1ba0ab3328483d1aebe864c91e3fc8cee8f02be69fff4b0fe405440de09e`；public=`99c317d5d963925984cc5cc9d939990c3f4417f73aec0d8f81ea1bccc14b4430`；Direct candidate=`2c7e83a684dde9438c39db24cf47c28f1c43104663eff68e1b6f314e965dd6c5`；Direct result=`55185e214006aefa6895299d591662d4a52bf3f3d1bf4fccf2aef1d4c7ed1c7f`；no-entry=`2037a8e41c4cd095142b749b99f63258325f2053a021d3ac1c575085ac7924dd`。

### Suite 终局与证据边界

`projects/v3.2-u1-value-validation/SUITE_MANIFEST.json` SHA-256=`b50ac3440a5be4c6eca889bb8453a609c1a6ad826bf9781cb59c16a63f389f2d`；零网络生成的 `U1_TECHNICAL_SUITE_REPORT.json` SHA-256=`0170d0d0ff3a5b8a2c9c09e8aeb9d93073fe44d6ef8fcadc12bd7dbead69e486`。Reporter 绑定三份当前合同和当前 scoring identity，`holdoutContentReadByReporter=false`。

本轮三案全阶段总计：`297 logical / 297 HTTP / 0 transport retry`；semantic/application schema repairs=5；Token=`542529 prompt / 134085 completion`，297/297 responses 有 usage。Token 策略全程 provider-default/observe-only；仓库没有本轮可绑定的正式价格表和货币 cost artifact，因此不补算货币成本。

三案均形成真实 Adaptive、terminal public-select、Direct 和 canonical no-entry 证据；没有合格新 evolved champion，全部保留 Starting Reference，sealed body 总读取次数=0，release/push/publish 均未发生。结论只能是：终止状态链和当前工程主链在三案中正常运行，但本轮三个自然重建合同没有证明 Adaptive 演化增益；Case 1/3 的原版 B0 被保留，Case 2 的 S0 被保留。该结果不证明 U1 普遍无效，也不能把同模型评分当成独立人类评审。

最终新鲜验收：`npm run build` 通过；`npm test`=`772 pass / 0 fail`；`git diff --check` 通过（仅有 Windows 工作树 LF→CRLF 提示）；活跃 `src/dist/README/U1_CONTRACT` Pairwise 专属符号=0；三个活动 Case 目录旧 contract hash=0；54 个 tracked/current evidence 文件中配置的真实 API key=0、private key=0；15 个 bootstrap/candidate/current-result 文件 sealed body marker=0；三个 Case 目录 tmp/staging/backup/debug/scratch=0。`.gitignore` 仍仅有用户既存的 `projects/v3.2-u1-value-validation/` 单行新增，未被改写、暂存或提交。
