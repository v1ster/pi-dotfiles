/**
 * 敏感命令守卫 (Command Guard)
 *
 * 拦截 bash 工具中的敏感命令，执行前请求用户批准：
 *   rm、sudo、磁盘操作、危险 git 操作、远程脚本管道等。
 *
 * - 交互模式 (TUI/RPC): 弹出确认框，批准后执行，拒绝则阻止
 * - 无界面模式 (-p/json): 默认直接阻止，保证无人值守安全
 *
 * 修改下方 RULES 即可增删需要批准的命令。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

interface Rule {
  pattern: RegExp;
  hint: string;
}

// ── 敏感命令规则表：按需增删 ──────────────────────────────
const RULES: Rule[] = [
  { pattern: /\bsudo\b/, hint: "sudo 提权" },
  { pattern: /\brm\b/, hint: "rm 删除文件" },
  { pattern: /\b(shutdown|reboot|poweroff|halt)\b/, hint: "关机/重启" },
  { pattern: /\bdd\b/, hint: "dd 块级写入" },
  { pattern: /\b(mkfs\.?\w*|fdisk|parted)\b/, hint: "磁盘/分区操作" },
  { pattern: /\bchmod\b[^;]*?(777|666|a\+rwx)\b/, hint: "chmod 宽松权限" },
  { pattern: /\bchown\b/, hint: "chown 更改属主" },
  { pattern: /\b(git push|git reset --hard|git clean\s+-f|git branch\s+-D)\b/, hint: "危险 git 操作" },
  { pattern: /\b(curl|wget)\b[^|;]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/, hint: "管道执行远程脚本" },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, hint: "fork bomb" },
];

/** 按 shell 规则切分参数，引号内的空格不会被拆开 */
function tokenizeArgs(s: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

/**
 * 判断命令是否为仅删除 /tmp 路径下文件的 rm 操作（视为安全，无需确认）
 *   安全: rm -rf /tmp/cache、rm -f /tmp/foo bar、rm -rf "/tmp/a b"、rm -rf /tmp/*
 *   不安全: rm -rf /tmp/x /etc/passwd、rm -rf /tmpfoo、rm -rf /tmp/x; sudo reboot
 */
function isSafeTmpRm(command: string): boolean {
  // 含命令拼接/管道/变量展开/子 shell 时不做豁免
  if (/[;&|`$]/.test(command)) return false;

  // 提取 rm 之后的参数并切分（处理引号内的空格）
  const m = command.match(/\brm\b\s+(.+)$/);
  if (!m) return false;
  const args = tokenizeArgs(m[1]);

  let hasPath = false;
  for (const arg of args) {
    // 跳过选项（-rf、--preserve-root 等）与 "--" 分隔符
    if (arg === "--" || arg.startsWith("-")) continue;
    hasPath = true;
    // 所有路径必须位于 /tmp 下（或 /tmp 本身）
    if (!/^\/tmp(?:\/|$)/.test(arg)) return false;
  }
  return hasPath;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return undefined;

    const command = event.input.command;
    let matched = RULES.filter((r) => r.pattern.test(command));

    // 仅删除 /tmp 路径下文件的 rm 操作视为安全，跳过确认
    if (
      matched.some((r) => r.hint === "rm 删除文件") &&
      isSafeTmpRm(command)
    ) {
      matched = matched.filter((r) => r.hint !== "rm 删除文件");
    }

    if (matched.length === 0) return undefined;

    // 无界面环境（-p / json / rpc 无人值守）：默认阻止，保证安全
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `敏感命令被阻止（无交互界面，无法确认）: ${command}`,
      };
    }

    const hints = matched.map((m) => m.hint).join("、");

    // —— 不截断方案：命令已在工具卡片/模拟终端中展示，overlay 只做定性确认
    //    固定 2 行文案，overlay 高度恒定 ≈7 行，永不 > termHeight，不会闪烁
    const allowed = await ctx.ui.confirm(
      "⚠️ 请确认操作",
      `检测到 [${hints}] 敏感操作, 是否允许?`,
    );

    if (!allowed) {
      ctx.ui.notify("已阻止敏感命令", "info");
      return { block: true, reason: `用户拒绝了敏感命令: ${command}` };
    }

    return undefined; // 放行
  });
}
