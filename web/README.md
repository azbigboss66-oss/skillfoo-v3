# SkillFoo 作品集前端

[打开公开网站](https://skillfoo-v32-evolution.warm-chub-8493.chatgpt.site/)

这是独立的 React / Vite 静态展示页：包含交互架构、三组演化案例、版本对比和可下载的 SKILL.md。案例状态与文件在浏览器本地计算，不调用付费 Provider，不依赖根目录 CLI、密钥或运行报告。实际 Skill 演化仍通过仓库根目录的 CLI 执行。

## 本地运行

推荐 Node.js 24 LTS（案例检查直接运行 TypeScript 模块）。从仓库根目录进入 `web`：

```bash
cd web
npm ci
npm run check:cases
npm run check:story
npm run build
npm run preview -- --host 127.0.0.1 --port 4174 --strictPort
```

打开 <http://127.0.0.1:4174/>。开发时使用 `npm run dev`。`build` 包含 TypeScript 检查，产物在 `dist/`；生产托管只需要该目录，无需保持本地服务在线。

## 配置与边界

- 右上角 GitHub 链接默认指向本仓库。构建时可选用公开变量 `VITE_GITHUB_URL` 覆盖；未设置、空字符串或空白均保留默认值。任何 `VITE_*` 变量都会暴露给浏览器，不能存放凭据。
- 构建生成 `/version.json`，含 `releaseId` 与当前 Git 提交的 `sourceCommit`。构建需在 Git checkout 内执行；不同托管仓库的提交 SHA 可以不同，应通过源码与静态产物哈希核对对应关系。
- 字体从 npm 依赖打包，视频和品牌图位于 `public/assets/`；不依赖临时本地文件路径。
- 本目录不包含历史运行证据、sealed 材料、人工确认、真实业务原始资料或私有 Sites 配置。
- 根目录的 CLI 配置、Provider、算法和测试不受本目录影响。展示页也不是 CLI 测试的依赖。

## 主要文件

| 位置 | 职责 |
| --- | --- |
| `src/App.tsx` | 页面入口、导航和架构联动 |
| `src/GenomeFlow.tsx` | 固定 1925×817 架构轨迹与阶段高亮 |
| `src/features/evolution/` | 案例状态、版本叙事、评测和文件操作 |
| `src/data/` | 独立案例数据及方法来源 |
| `scripts/check-cases.mjs` | 候选资格、评分、谱系和内容合同检查 |
| `scripts/check-story.mjs` | 版本叙事与手动阶段导航检查 |
