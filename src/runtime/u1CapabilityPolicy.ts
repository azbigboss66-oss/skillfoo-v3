import type { CapabilityBoundary } from "../types.js";

export type U1CapabilityChannel = "network" | "filesystem" | "externalActions";
export type U1CapabilityFindingKind =
  | "safe_refusal"
  | "execution_instruction"
  | "false_execution_claim"
  | "boundary_ambiguous";
export type U1CapabilityFindingCode =
  | "network"
  | "filesystem"
  | "shell"
  | "plugin"
  | "dsh"
  | "script"
  | "reference"
  | "external_action";

export interface U1CapabilityFinding {
  code: U1CapabilityFindingCode;
  channel: U1CapabilityChannel;
  kind: U1CapabilityFindingKind;
  disposition: "prohibited_statement" | "execution_instruction" | "execution_claim";
  line: number;
  excerpt: string;
  evidence: string;
  blocking: boolean;
}

export interface U1CapabilityAnalysis {
  passed: boolean;
  findings: U1CapabilityFinding[];
}

export const U1_INSTRUCTION_ONLY_BOUNDARY: CapabilityBoundary = {
  allowedCapabilities: ["instruction"],
  network: "forbidden",
  filesystem: "forbidden",
  externalActions: "forbidden",
};

interface ChannelRule {
  channel: U1CapabilityChannel;
  mentions: RegExp;
  actions: RegExp;
}

const CHANNEL_RULES: readonly ChannelRule[] = [
  {
    channel: "network",
    mentions: /\b(?:network|internet|web|website|browser|browse|fetch|https?|api|curl|wget|download|online)\b|联网|网络|网页|官网|浏览器|检索|搜索|抓取|下载|接口/iu,
    actions: /\b(?:fetch|browse|search|download|call|invoke|query|visit|open|use|run)\b|联网|访问|浏览|检索|搜索|抓取|下载|调用|请求|运行/iu,
  },
  {
    channel: "filesystem",
    mentions: /\b(?:filesystem|file system|files?|directories|directory|folders?|references?\/|scripts?\/)|\b[\w.-]+\.(?:md|txt|json|ya?ml|csv|docx?|pdf)\b|文件系统|文件|目录|参考资料/iu,
    actions: /\b(?:read|write|delete|remove|open|save|scan|load|modify|edit|see)\b|读取|写入|删除|打开|保存|扫描|加载|修改|编辑|查看/iu,
  },
  {
    channel: "externalActions",
    mentions: /\b(?:shell|terminal|command|bash|zsh|powershell|exec|subprocess|node|npm|npx|pip|python|scripts?|plugins?|dsh|email|message|contact)\b|外部操作|命令|终端|脚本|插件|邮件|消息|联系客户/iu,
    actions: /\b(?:run|start|execute|exec|install|invoke|send|post|launch|use)\b|\bcontact\b(?!\s+(?:person|details?|name|information)\b)|运行|启动|执行|安装|调用|发送|发布|联系/iu,
  },
];

const SAFE_SCOPE = /\b(?:must\s+not|never|do\s+not|don't|does\s+not|cannot|can't|may\s+not|not\s+allowed|forbidden|prohibited|unavailable|no\s+access|no\s+(?:network|internet|web|filesystem|files?|shell|commands?|scripts?|plugins?|dsh|tools?)|out\s+of\s+scope|will\s+not|won't|without|refuse|decline|denied|none)\b|不得|不能|不应|禁止|严禁|不可|无权|无权限|没有权限|不支持|无法|拒绝|不执行|不联网|不读写|不读取|不写入|不运行|不发送|不发消息|不联系|不会|不允许|不要|不声称|不宣称|不会声称|未声称|未提供|而非外部|仅能|只能|超出范围|无工具/iu;

const ENGLISH_EXECUTION_CLAIM = /\b(?:i|we|the\s+skill|the\s+system|it)\s+(?:(?:have|has|had)\s+)?(?:already\s+)?(?:successfully\s+)?(?:fetched|browsed|searched|downloaded|called|visited|read|wrote|deleted|opened|saved|scanned|ran|executed|installed|invoked|sent|posted|contacted)\b|\b(?:has|have|had)\s+been\s+(?:written|deleted|saved|sent|posted|executed)\b/iu;
const CHINESE_EXECUTION_CLAIM = /(?:已|已经|刚刚|成功|完成了)[^；;。.!?！？]*(?:联网|访问|浏览|检索|搜索|抓取|下载|调用|读取|写入|删除|打开|保存|扫描|运行|执行|安装|发送|发布|联系)/u;

function findingCode(channel: U1CapabilityChannel, clause: string): U1CapabilityFindingCode {
  if (channel === "network") return "network";
  if (channel === "filesystem") {
    return /\breferences?\s*[\\/]/iu.test(clause) ? "reference" : "filesystem";
  }
  if (/\bdsh\b/iu.test(clause)) return "dsh";
  if (/\bplugins?\b|插件/iu.test(clause)) return "plugin";
  if (/\bscripts?\b|脚本/iu.test(clause)) return "script";
  if (/\b(?:shell|terminal|bash|zsh|powershell|exec|subprocess|command)\b|命令|终端/iu.test(clause)) return "shell";
  return "external_action";
}

function clausesOf(line: string): string[] {
  return line
    .split(/(?<=[;；。!?！？])\s*|，\s*(?=(?:fetch|browse|search|download|call|invoke|query|visit|open|use|run|start|execute|exec|install|send|post|launch)\b|联网|访问|浏览|检索|搜索|抓取|下载|调用|请求|运行|启动|执行|安装|发送|发布|联系|读取|写入|删除|打开|保存|扫描|加载|修改|编辑|查看)|\s+(?=(?:then|and|however|but)\b)|(?=然后|随后|再|并|但是|但)/iu)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function classifyClause(clause: string, rule: ChannelRule): U1CapabilityFindingKind {
  if (SAFE_SCOPE.test(clause)) return "safe_refusal";
  if (ENGLISH_EXECUTION_CLAIM.test(clause) || CHINESE_EXECUTION_CLAIM.test(clause)) {
    return "false_execution_claim";
  }
  if (/\b(?:references?|scripts?)\s*[\\/]/iu.test(clause)) return "execution_instruction";
  if (rule.actions.test(clause)) return "execution_instruction";
  return "boundary_ambiguous";
}

/**
 * Deterministic, line-level U1 policy analysis. Capability nouns are not
 * violations by themselves: prohibition/refusal scope is retained as safe
 * evidence, while instructions and claims of unavailable execution block.
 */
export function analyzeU1CapabilityText(
  text: string,
  boundary: CapabilityBoundary,
): U1CapabilityAnalysis {
  const findings: U1CapabilityFinding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((lineText, index) => {
    for (const clause of clausesOf(lineText)) {
      for (const rule of CHANNEL_RULES) {
        if (boundary[rule.channel] !== "forbidden" || !rule.mentions.test(clause)) continue;
        const kind = classifyClause(clause, rule);
        const blocking = kind === "execution_instruction" || kind === "false_execution_claim";
        const excerpt = clause.slice(0, 120);
        findings.push({
          code: findingCode(rule.channel, clause),
          channel: rule.channel,
          kind,
          disposition:
            kind === "execution_instruction"
              ? "execution_instruction"
              : kind === "false_execution_claim"
                ? "execution_claim"
                : "prohibited_statement",
          line: index + 1,
          excerpt,
          evidence: excerpt,
          blocking,
        });
      }
    }
  });
  return { passed: findings.every((finding) => !finding.blocking), findings };
}

export function blockingU1CapabilityFindings(
  text: string,
  boundary: CapabilityBoundary,
): U1CapabilityFinding[] {
  return analyzeU1CapabilityText(text, boundary).findings.filter((finding) => finding.blocking);
}
