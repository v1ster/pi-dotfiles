---
name: plans-first
description: Local-first planning before coding. Use when a task needs 3+ steps, touches 2+ files, or the request is vague. Explore the codebase, write a concise verifiable plan to .pi/plans/, then STOP for approval instead of coding directly.
---

# Plans-First

## 1. 何时用

用：3步以上 / 动2+文件 / 需求模糊 / 用户说“先给计划”。
不用：单文件小改、查代码、用户说“直接改”。

## 2. 流程（只读，不写代码）

开头说：`我用 plans-first 先给计划，不写代码。`

禁止 `edit/write` 业务代码，只允许 `read/bash(ls,rg,git diff/log)` 探索。

1. **定范围**：目标一句话 + 非目标。多子系统可独立交付就拆多个 plan，一次写一个。
2. **提问（如需）**：仅当关键信息缺失且无法从代码推断时问。最多问一次、最多5个，编号列出，等回复再写计划。能查到就不问。
3. **探索**：画文件地图（新建/修改/只读），沿用仓库已有模式，不擅自重构大文件。
4. **写计划**：按 §4 模板写文件，100行内，超了就拆任务。
5. **停**：报路径 + Task数 + 最大风险，问“批准吗？执行另起 session”。不顺手开写。

## 3. 保存位置

默认 `<project>/.pi/plans/YYYY-MM-DD-<feature-name>.md`，想进版本库才用 `docs/plans/`。同名计划已存在就读它并在此改，不另起。

## 4. 计划模板

```markdown
# [功能名] 计划

**Goal:** [一句话]
**Scope:** [做 X / 不做 Y]
**Spec:** [口头需求/对话/issue链接]

## 文件地图

- 新建：`exact/path/a.ts` — [职责]
- 修改：`exact/path/b.ts:120-145` — [改什么]
- 只读：`exact/path/c.ts` — [查什么]

## 全局约束

[版本/依赖/规范，一行一条，无则写“无”]

---

### Task 1: [名]

**Files:** 地图子集
**Do:** [ ] ...（关键签名/命令，不贴大段代码）
**Verify:** [独立可跑命令+预期结果，如 `pnpm test path/to/test.ts`]
**Commit:** [如 `feat: xxx`，一Task一次]

### Task 2: ...

## 风险

- [最大风险 + 回退，一行一条]
```

Task切分：一个Task = 可独立review/验证的单元 + 自带Verify。脚手架折进需要的Task，不单独成Task。

## 5. 规则

No Placeholders（命中就重写）：`TBD/TODO/后续再说/适当处理`；只写“加验证”不写具体哪种错误+怎么验；“参考Task N”（每Task自包含）；引用未定义的函数/类型；Verify无命令。

Self-Review：①每条需求都能指到Task吗 ②搜`TBD/TODO/适当/相关/等等`改具体 ③函数名/参数/路径一致吗。

## 6. Handoff

```
计划已存 `.pi/plans/<file>.md`，共N个Task。最大风险：xxx。
批准我另起session按Task执行吗？
```
