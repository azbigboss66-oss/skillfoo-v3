export type MethodSource = {
  name: string; title: string; author: string; year: number; url: string;
  kind: 'reference' | 'related'; idea: string; mapping: string; boundary: string;
  stage?: number;
};

export const METHOD_SOURCES: MethodSource[] = [
  {
    name: 'Promptbreeder', title: 'Promptbreeder: Self-Referential Self-Improvement Via Prompt Evolution',
    author: 'Chrisantha Fernando et al.', year: 2023, url: 'https://arxiv.org/abs/2309.16797', kind: 'reference', stage: 3,
    idea: '维护提示族群，通过变异和适应度评价逐步选择更好的版本。',
    mapping: '启发 Anchor、Elite、Diversity 的多源候选与累计池重选。',
    boundary: '借鉴族群选择，不复现论文中 mutation-prompt 自身的演化。',
  },
  {
    name: 'EvoPrompt', title: 'EvoPrompt: Connecting LLMs with Evolutionary Algorithms Yields Powerful Prompt Optimizers',
    author: 'Qingyan Guo et al.', year: 2023, url: 'https://arxiv.org/abs/2309.08532', kind: 'reference', stage: 3,
    idea: '让 LLM 生成连贯、可读的文本候选，再用演化算法评价和选择。',
    mapping: '启发 exploit 与 diversify 两种改写路线；产物是可比较的完整 SKILL.md。',
    boundary: '双路受限变异并非论文 GA / DE 算法的完整复现。',
  },
  {
    name: 'OPRO', title: 'Large Language Models as Optimizers',
    author: 'Chengrun Yang et al.', year: 2023, url: 'https://arxiv.org/abs/2309.03409', kind: 'reference', stage: 4,
    idea: '将历史方案及其评价提供给语言模型，驱动下一轮候选改进。',
    mapping: '启发评价反馈驱动改进；本项目区分训练反馈、公共选择和独立复核。',
    boundary: 'Holdout 只复核冻结版本，不把其分数反馈给变异或公共选择。',
  },
  {
    name: 'Tree of Thoughts', title: 'Tree of Thoughts: Deliberate Problem Solving with Large Language Models',
    author: 'Shunyu Yao et al.', year: 2023, url: 'https://arxiv.org/abs/2305.10601', kind: 'reference', stage: 3,
    idea: '保留多个可评价的探索分支，而不是只沿一条路径向前。',
    mapping: '启发分支探索与筛选：失败候选可以淘汰，其他策略仍然继续。',
    boundary: '论文搜索的是推理中的思维步骤；这里搜索的是 Skill 文件版本。',
  },
  {
    name: 'Self-Refine', title: 'Self-Refine: Iterative Refinement with Self-Feedback',
    author: 'Aman Madaan et al.', year: 2023, url: 'https://arxiv.org/abs/2303.17651', kind: 'related',
    idea: '由模型生成初稿，再提供反馈并迭代修订输出。',
    mapping: '相关思路是“反馈应落到具体修改”；可与候选的规则差异对照理解。',
    boundary: '项目不宣称实现该完整框架；独立 Direct 一次改写也不等同于 Self-Refine。',
  },
  {
    name: 'Reflexion', title: 'Reflexion: Language Agents with Verbal Reinforcement Learning',
    author: 'Noah Shinn et al.', year: 2023, url: 'https://arxiv.org/abs/2303.11366', kind: 'related',
    idea: '用语言反思记录反馈，并在后续尝试中利用这些经验。',
    mapping: '相关思路是把失败原因写清楚，让下一次改进有明确方向。',
    boundary: '保留变异记录不等于实现论文中带 episodic memory 的 Agent。',
  },
];
