import test from "node:test";
import assert from "node:assert/strict";
import type { CapabilityBoundary } from "../types.js";
import { analyzeU1CapabilityText } from "./u1CapabilityPolicy.js";

const U1_BOUNDARY: CapabilityBoundary = {
  allowedCapabilities: ["instruction"],
  network: "forbidden",
  filesystem: "forbidden",
  externalActions: "forbidden",
};

const SAFE_REFUSALS = [
  "Network access is forbidden; do not call HTTP APIs.",
  "I cannot browse the web, so I will reason only from the supplied text.",
  "Never read or write files; ask the user to paste the necessary content.",
  "Shell commands and PowerShell are not allowed in this instruction-only skill.",
  "No plugins or DSH tools are available; provide a manual checklist instead.",
  "不得联网搜索网页，只能依据用户本轮提供的信息回答。",
  "无法读取、写入或删除文件；请用户直接粘贴必要内容。",
  "不执行脚本、命令或外部操作，也不会声称已经执行。",
];

const EXECUTION_INSTRUCTIONS = [
  "Fetch the latest tender page and summarize it.",
  "Use curl https://example.com/data to download the source.",
  "Read references/policy.md before answering.",
  "Write the final report to output.md.",
  "Run the PowerShell script and inspect its output.",
  "Install the plugin, then invoke it for monitoring.",
  "请联网搜索最新政策并访问官网。",
  "读取本地文件后执行脚本，把结果发送给客户。",
];

const FALSE_EXECUTION_CLAIMS = [
  "I fetched the current policy from the official website.",
  "The report has been written to output.md.",
  "I ran the shell command successfully.",
  "I have sent the email to the customer.",
  "我已经联网检索了最新招标信息。",
  "已读取本地文件并成功执行脚本。",
];

test("safe Chinese and English refusal/boundary text is evidence, not a violation", () => {
  for (const text of SAFE_REFUSALS) {
    const result = analyzeU1CapabilityText(text, U1_BOUNDARY);
    assert.equal(result.passed, true, text);
    assert.ok(result.findings.some((finding) => finding.kind === "safe_refusal"), text);
    assert.ok(result.findings.every((finding) => finding.blocking === false), text);
  }
});

test("imperative execution instructions fail with line-level structured evidence", () => {
  for (const text of EXECUTION_INSTRUCTIONS) {
    const result = analyzeU1CapabilityText(text, U1_BOUNDARY);
    assert.equal(result.passed, false, text);
    const finding = result.findings.find((entry) => entry.kind === "execution_instruction");
    assert.ok(finding, text);
    assert.equal(finding.blocking, true);
    assert.equal(finding.line, 1);
    assert.ok(finding.excerpt.length > 0 && finding.excerpt.length <= 120);
  }
});

test("claims that an unavailable action already occurred fail separately from instructions", () => {
  for (const text of FALSE_EXECUTION_CLAIMS) {
    const result = analyzeU1CapabilityText(text, U1_BOUNDARY);
    assert.equal(result.passed, false, text);
    assert.ok(result.findings.some((finding) => finding.kind === "false_execution_claim"), text);
  }
});

test("prohibition scope is clause-local and cannot hide a later execution step", () => {
  const result = analyzeU1CapabilityText(
    "Do not browse the web; 然后调用 API 获取最新数据。",
    U1_BOUNDARY,
  );
  assert.equal(result.passed, false);
  assert.ok(result.findings.some((finding) => finding.kind === "safe_refusal"));
  assert.ok(result.findings.some((finding) => finding.kind === "execution_instruction" && finding.blocking));
});

test("the Case A S0 boundary language passes despite naming filesystem and scripts", () => {
  const caseABoundary = [
    "- Network access: forbidden — must not fetch, browse, or call any external HTTP service.",
    "- Filesystem access: forbidden — must not read, write, or delete any file.",
    "- External actions: forbidden — must not execute commands, scripts, or send anything on the operator's behalf.",
    "- Never claim to have searched the web, CRM, files, or any external system, or to have contacted anyone.",
  ].join("\n");
  const result = analyzeU1CapabilityText(caseABoundary, U1_BOUNDARY);
  assert.equal(result.passed, true);
  assert.ok(result.findings.length >= 4);
  assert.ok(result.findings.every((finding) => !finding.blocking));
});

test("real Case A mutation wording is not misclassified as unavailable execution", () => {
  const safeMutationLines = [
    "- 不声称搜索过网页、CRM、文件或任何外部系统，也不声称联系过任何人。",
    "- Any other material facts stated (e.g., current stage, contact person, next step promised)",
    "- 将每条信息拆分为：主体（客户/组织）、事件（说了什么/发生了什么）、时间（何时）、来源（用户直接提供，而非外部检索）。",
    "- 不联网、不读写文件、不运行命令、不发消息。",
  ];
  for (const line of safeMutationLines) {
    const result = analyzeU1CapabilityText(line, U1_BOUNDARY);
    assert.equal(result.passed, true, line);
    assert.ok(result.findings.every((finding) => !finding.blocking), line);
  }
});

test("a Chinese denial before a comma cannot hide a later execution instruction", () => {
  const result = analyzeU1CapabilityText("不联网，运行命令获取数据。", U1_BOUNDARY);
  assert.equal(result.passed, false);
  assert.ok(result.findings.some((finding) => finding.code === "shell" && finding.blocking));
});

test("contact used as a real external-action verb still blocks", () => {
  const result = analyzeU1CapabilityText("Contact the client and send the report.", U1_BOUNDARY);
  assert.equal(result.passed, false);
  assert.ok(result.findings.some((finding) => finding.code === "external_action" && finding.blocking));
});

test("channels allowed by the Task Card are ignored by U1 prohibition analysis", () => {
  const boundary: CapabilityBoundary = {
    ...U1_BOUNDARY,
    network: "allowed",
  };
  const result = analyzeU1CapabilityText("Fetch the latest tender page.", boundary);
  assert.equal(result.passed, true);
  assert.deepEqual(result.findings, []);
});
