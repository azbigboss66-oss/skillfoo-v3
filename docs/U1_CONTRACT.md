# SkillFoo V3.2 U1 Current Contract

本文只描述当前可运行的 U1 正式主链，不承诺读取或恢复已退役的 V1/V2、closure 或 development-bypass 产物。

## 优化边界

- 唯一可变对象是候选根中的 `SKILL.md`。
- references、attachments 和 replay fixture 位于候选根之外，只能通过冻结 manifest 中声明的逻辑 ID 读取；它们不可修改。
- 禁止网络、任意脚本、命令、插件、写文件、未声明工具和完整 Skill 包优化。
- B0 永久只读；S0 只由已确认 Task Card 的完整五项意图生成。

## 人工门禁与冻结身份

正式 live 路径必须同时满足：

1. 用户确认 Task Card；
2. 用户确认 sealed-safe 中文评测摘要；
3. 两次确认均以 `confirmationMode=human` 绑定其内容哈希；
4. `humanConfirmationBypassed=false`；
5. formal contract、runtime context、B0/S0、split、scoring identity，以及 Provider 的 adapter version、endpoint identity、model、auth mode、request profile 和各角色运行指纹均未漂移。

`test-fixture` 仅能在操作系统临时目录进行零网络自动化验证，不能形成 formal evidence，不能调用真实 Provider，也不能进入 sealed。生产 CLI 不提供 development bypass。

## 当前评分身份

- scoring profile：`u1-scoring-profile-v3`
- task verifier：`u1-task-verifier-v3`
- five-dimension rubric：`u1-five-dimension-rubric-v2`

五维为 task correctness、evidence boundary、capability boundary、output structure 和 actionability。普通 quality 缺口只封顶所绑定维度；hard safety 会淘汰候选，hard contract 会阻止其成为冠军。critical 只由 critical hard-safety 或 critical hard-contract 触发。单个维度的小幅下降若仍高于最低线且没有硬规则或受保护行为回归，不会单独触发回滚。

资格分为三层：Comparison baseline 只要求合同/输入身份有效、任务项证据完整可审计且没有 hard safety 或基础设施/证据完整性故障；Eligible champion 还必须通过严格 JSON、deterministic verifier、hard contract、五维最低线和关键项；Releaseable candidate 再要求 public-select 的合格新冠军、Direct、人工门和 sealed/release 门。候选已完整运行但产生 `invalid_json` 或其他 non-final 答案时，该 item 仍严格记 0 且 hard contract 失败，候选不能成为冠军；只要安全且每项证据完整，它仍可作为比较基准。“完成但得 0 分”不等于“评测没有完成”。安全越界，或 Provider、评估器、预算、缺证据及身份漂移，则不能形成比较基准。

## 演化与选择

当前链为：

```text
B0 / S0
→ generation-0 public-train
→ Anchor / Elite / Diversity
→ exploit / diversify 有界编辑
→ targeted repair（同一 public-train 反馈）
→ terminal public-select
→ one-shot Direct
→ 条件式 one-shot sealed audit
→ 替换或保留 Starting Reference
```

相同 `SKILL.md` 哈希只评测一次且只占一个种群席位。候选局部失败不关闭健康兄弟或整代；没有合格新冠军时保留 Starting Reference 是正常结果。

不同哈希的挑战者必须先通过严格 JSON、deterministic verifier、hard contract、五维最低线、安全/能力/红线和 critical regression 门；terminal public-select 在这些合格挑战者中按 public weighted mean 降序、同分按稳定哈希顺序选择最佳者。最佳者相对 Starting Reference 的 public score delta 达到 3 时形成 `clear_improvement`，低于 3 时保留 Starting Reference。当前正式终局不使用 `uncertain`。

## Semantic JSON 恢复

每个非 sealed semantic batch 最多有一次内容无关的 schema repair。只有严格响应合同错误可触发恢复；恢复提示不包含被拒绝响应正文，第二次仍非法即失败，禁止第三次。网络、timeout、429、Provider、预算、低分或能力违规不能触发 schema repair。

Calibration 有 2 个独立 primary pass，每个 pass 最多一次 schema repair，因此独立授权为 4 logical calls、0 transport retries。public-select 和 Direct 各自在本阶段动态预算中预留 semantic recovery；sealed 的应用层 recovery reserve 恒为 0。

## 动态调用与 Token

候选场景和各阶段使用冻结执行图计算动态调用包络，默认 `callEnvelopeMultiplier=2.0`。阶段预算互相独立，不借用；达到授权上限即 fail closed。transport retry、candidate-item application retry 与 semantic schema repair 分别记账。

U1 默认不发送 token ceiling 字段，只观察 Provider 返回的 token usage。只有操作员显式覆盖时，才按冻结 request profile 发送 `max_tokens` 或 `max_completion_tokens`。request timeout 继续生效；缺失 usage 记录为 unknown，不补零。

Live 路径统一使用 OpenAI-compatible Chat Completions adapter；`bearer` 才发送 `Authorization` header，`none` 不发送，但两者都必须通过相同的网络、成本确认与 no-release 门禁。endpoint 只以不透明哈希进入持久化身份，密钥永不进入身份、缓存或结果产物。

## Sealed 与发布

sealed 只在 public-select 形成合格的新 `clear_improvement`、Direct 已绑定且 formal 2/2 未漂移时读取一次。sealed 无应用层重试、无 schema repair、无反馈回流；不满足条件时正文读取数和 Provider 调用数均为 0。

所有正式实验均使用 `--no-release`。GitHub source、npm package 和候选 Skill 发布是三个独立决定；CLI 不会自动 push、publish 或 release。
