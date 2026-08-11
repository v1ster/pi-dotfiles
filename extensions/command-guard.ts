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

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return undefined;

    const command = event.input.command;
    const matched = RULES.filter((r) => r.pattern.test(command));

    if (matched.length === 0) return undefined;

    // 无界面环境（-p / json / rpc 无人值守）：默认阻止，保证安全
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `敏感命令被阻止（无交互界面，无法确认）: ${command}`,
      };
    }

    const hints = matched.map((m) => m.hint).join("、");
    const allowed = await ctx.ui.confirm(
      "⚠️ 敏感命令需要批准",
      `检测到 [${hints}]\n\n命令: ${command}\n\n是否允许执行？`,
    );

    if (!allowed) {
      ctx.ui.notify("已阻止敏感命令", "info");
      return { block: true, reason: `用户拒绝了敏感命令: ${command}` };
    }

    return undefined; // 放行
  });
}
