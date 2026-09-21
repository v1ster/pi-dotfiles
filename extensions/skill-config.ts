import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";

export interface SkillConfig {
	default?: "default" | "disabled" | "enabled";
	skills?: Record<string, boolean>;
}

const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", "skill-visibility.json");
const PROJECT_CONFIG_NAME = ".pi/skill-visibility.json";

function resolveConfigPath(cwd?: string): string {
	if (cwd) {
		const projectPath = join(cwd, PROJECT_CONFIG_NAME);
		if (existsSync(projectPath)) {
			return projectPath;
		}
	}
	return GLOBAL_CONFIG_PATH;
}

export function loadConfig(cwd?: string): { config: SkillConfig; path: string } {
	const configPath = resolveConfigPath(cwd);
	try {
		if (existsSync(configPath)) {
			const raw = readFileSync(configPath, "utf-8");
			const data = JSON.parse(raw);
			return {
				config: {
					default: data.default === "disabled" || data.default === "enabled" ? data.default : "default",
					skills: typeof data.skills === "object" && data.skills !== null ? data.skills : {},
				},
				path: configPath,
			};
		}
	} catch {
		// fallback on parse error
	}
	return {
		config: { default: "default", skills: {} },
		path: configPath,
	};
}

export function saveConfig(config: SkillConfig, targetPath?: string, cwd?: string): string {
	const configPath = targetPath || resolveConfigPath(cwd);
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
	return configPath;
}

export function applySkillConfig(skills: Array<{ name: string; disableModelInvocation: boolean }>, config: SkillConfig): void {
	const defaultPolicy = config.default || "default";
	const overrides = config.skills || {};

	for (const skill of skills) {
		if (typeof overrides[skill.name] === "boolean") {
			skill.disableModelInvocation = !overrides[skill.name];
		} else if (defaultPolicy === "disabled") {
			skill.disableModelInvocation = true;
		} else if (defaultPolicy === "enabled") {
			skill.disableModelInvocation = false;
		}
	}
}

export default function skillConfigExtension(pi: ExtensionAPI) {
	const knownSkills = new Map<string, { name: string; description?: string }>();

	pi.on("before_agent_start", async (event, ctx) => {
		const skills = event.systemPromptOptions.skills ?? [];
		if (skills.length === 0) return undefined;

		for (const s of skills) {
			knownSkills.set(s.name, { name: s.name, description: s.description });
		}

		const { config } = loadConfig(ctx.cwd);
		applySkillConfig(skills, config);
		return undefined;
	});

	function getAllKnownSkills(): Array<{ name: string; description?: string }> {
		const map = new Map<string, { name: string; description?: string }>();

		// 1. From pi commands (skills register slash commands as skill:name)
		try {
			const commands = pi.getCommands ? pi.getCommands() : [];
			for (const cmd of commands) {
				if (cmd.source === "skill") {
					const cleanName = cmd.name.startsWith("skill:") ? cmd.name.slice(6) : cmd.name;
					map.set(cleanName, { name: cleanName, description: cmd.description });
				}
			}
		} catch {
			// ignore
		}

		for (const [name, skill] of knownSkills) {
			if (!map.has(name)) {
				map.set(name, skill);
			}
		}

		const { config } = loadConfig();
		if (config.skills) {
			for (const name of Object.keys(config.skills)) {
				if (!map.has(name)) {
					map.set(name, { name });
				}
			}
		}

		return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
	}

	function getSkillEffectiveStatus(skillName: string, config: SkillConfig): {
		tag: string;
		statusText: string;
		isModel: boolean;
		isExplicit: boolean;
	} {
		const overrides = config.skills || {};
		const defaultPolicy = config.default || "default";

		if (overrides[skillName] === true) {
			return { tag: "[✓ Model]", statusText: "Model Auto (Override: Enabled)", isModel: true, isExplicit: true };
		}
		if (overrides[skillName] === false) {
			return { tag: "[✗ Manual]", statusText: "Manual Only (Override: Disabled)", isModel: false, isExplicit: true };
		}
		if (defaultPolicy === "disabled") {
			return { tag: "[✗ Default]", statusText: "Manual Only (Default: Disabled)", isModel: false, isExplicit: false };
		}
		if (defaultPolicy === "enabled") {
			return { tag: "[✓ Default]", statusText: "Model Auto (Default: Enabled)", isModel: true, isExplicit: false };
		}
		return { tag: "[○ Auto]", statusText: "Auto (Skill Frontmatter Default)", isModel: true, isExplicit: false };
	}

	async function openInteractiveTui(ctx: any) {
		const allSkills = getAllKnownSkills();
		if (allSkills.length === 0) {
			ctx.ui.notify("No skills found in current session.", "info");
			return;
		}

		let { config, path: configPath } = loadConfig(ctx.cwd);
		let selectedIndex = 0;
		const maxVisible = 10;

		await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (val: any) => void) => {
			function cycleSkill(skillName: string) {
				config.skills = config.skills || {};
				const current = config.skills[skillName];
				if (current === true) {
					// Model -> Manual
					config.skills[skillName] = false;
				} else if (current === false) {
					// Manual -> Auto (Default)
					delete config.skills[skillName];
				} else {
					// Auto -> Model
					config.skills[skillName] = true;
				}
				saveConfig(config, configPath, ctx.cwd);
			}

			function toggleAll() {
				config.skills = config.skills || {};
				const hasAnyManual = allSkills.some((s) => {
					const status = getSkillEffectiveStatus(s.name, config);
					return !status.isModel;
				});

				for (const s of allSkills) {
					// If some are manual, turn all to model; otherwise turn all to manual
					config.skills[s.name] = hasAnyManual;
				}
				saveConfig(config, configPath, ctx.cwd);
			}

			function cycleDefaultPolicy() {
				const current = config.default || "default";
				const next = current === "default" ? "disabled" : current === "disabled" ? "enabled" : "default";
				config.default = next;
				saveConfig(config, configPath, ctx.cwd);
			}

			const container = new Container();

			const component = {
				render(width: number): string[] {
					container.clear();
					const divider = "─".repeat(Math.max(10, width - 4));
					container.addChild(new Text(theme.fg("dim", `  ${divider}`), 0, 0));
					container.addChild(new Spacer(1));

					// Title & Status
					const title = theme.fg("accent", theme.bold("  Skill Model-Invocation Manager"));
					const defaultPolicy = (config.default || "default").toUpperCase();
					const subTitle = theme.fg(
						"muted",
						`  Default Policy: ${theme.bold(defaultPolicy)}  ·  Config: ${configPath}`,
					);
					container.addChild(new Text(title, 0, 0));
					container.addChild(new Text(subTitle, 0, 0));
					container.addChild(new Spacer(1));

					// Skill list
					const startIndex = Math.max(
						0,
						Math.min(selectedIndex - Math.floor(maxVisible / 2), allSkills.length - maxVisible),
					);
					const endIndex = Math.min(startIndex + maxVisible, allSkills.length);

					for (let i = startIndex; i < endIndex; i++) {
						const skill = allSkills[i];
						const isSelected = i === selectedIndex;
						const status = getSkillEffectiveStatus(skill.name, config);

						const prefix = isSelected ? theme.fg("accent", " → ") : "   ";
						let tagColor = "dim";
						if (status.isModel) {
							tagColor = status.isExplicit ? "accent" : "muted";
						} else {
							tagColor = status.isExplicit ? "warning" : "dim";
						}

						const tagStyled = theme.fg(tagColor, status.tag.padEnd(11));
						const nameStyled = isSelected ? theme.fg("accent", theme.bold(skill.name)) : theme.fg("text", skill.name);
						const descText = skill.description ? ` - ${skill.description.replace(/\n/g, " ").slice(0, 45)}` : "";
						const descStyled = theme.fg("muted", descText);

						container.addChild(new Text(`${prefix}${tagStyled} ${nameStyled}${descStyled}`, 0, 0));
					}

					if (allSkills.length > maxVisible) {
						container.addChild(
							new Text(theme.fg("dim", `   (${selectedIndex + 1}/${allSkills.length} skills)`), 0, 0),
						);
					}

					container.addChild(new Spacer(1));

					// Key Hints
					const hints = [
						`${theme.bold("↑/↓")} Move`,
						`${theme.bold("Tab/Space/Enter")} Toggle [✓ Model ↔ ✗ Manual ↔ ○ Auto]`,
						`${theme.bold("a")} Toggle All`,
						`${theme.bold("d")} Cycle Default Policy`,
						`${theme.bold("Esc")} Close`,
					].join(theme.fg("dim", "  ·  "));

					container.addChild(new Text(theme.fg("muted", `  ${hints}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `  ${divider}`), 0, 0));

					return container.render(width).map((line) => truncateToWidth(line, width));
				},

				invalidate() {
					container.invalidate();
				},

				handleInput(data: string) {
					if (matchesKey(data, Key.up) || data === "k") {
						selectedIndex = selectedIndex > 0 ? selectedIndex - 1 : allSkills.length - 1;
						tui.requestRender();
						return;
					}

					if (matchesKey(data, Key.down) || data === "j") {
						selectedIndex = selectedIndex < allSkills.length - 1 ? selectedIndex + 1 : 0;
						tui.requestRender();
						return;
					}

					if (
						matchesKey(data, Key.tab) ||
						matchesKey(data, Key.space) ||
						matchesKey(data, Key.enter) ||
						data === " " ||
						data === "\t" ||
						data === "\r" ||
						data === "\n"
					) {
						const skill = allSkills[selectedIndex];
						if (skill) {
							cycleSkill(skill.name);
						}
						tui.requestRender();
						return;
					}

					if (data === "a" || data === "A") {
						toggleAll();
						tui.requestRender();
						return;
					}

					if (data === "d" || data === "D") {
						cycleDefaultPolicy();
						tui.requestRender();
						return;
					}

					if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
						done(undefined);
						return;
					}
				},
			};

			return component;
		});
	}

	const commandHandler = async (args: string, ctx: any) => {
		const parts = args.trim().split(/\s+/).filter(Boolean);
		const subcommand = parts[0]?.toLowerCase();
		const targetSkill = parts[1];

		const { config, path: configPath } = loadConfig(ctx.cwd);

		if (!subcommand) {
			if (ctx.mode === "tui" && ctx.ui && typeof ctx.ui.custom === "function") {
				await openInteractiveTui(ctx);
			} else {
				// Fallback if not in TUI mode
				const allSkills = getAllKnownSkills();
				const lines = [
					`Skill Model-Invocation Manager (Default: ${config.default || "default"})`,
					`Config: ${configPath}`,
					"",
					...allSkills.map((s) => {
						const status = getSkillEffectiveStatus(s.name, config);
						return `  ${status.tag.padEnd(12)} ${s.name}`;
					}),
				];
				ctx.ui.notify(lines.join("\n"), "info");
			}
			return;
		}

		if (subcommand === "list" || subcommand === "status") {
			const allSkills = getAllKnownSkills();
			const defaultPolicy = config.default || "default";
			const lines = [
				`Default Policy: ${defaultPolicy}`,
				`Config File: ${configPath}`,
				"",
				...allSkills.map((s) => {
					const status = getSkillEffectiveStatus(s.name, config);
					return `  ${status.tag.padEnd(12)} ${s.name}`;
				}),
			];
			ctx.ui.notify(lines.join("\n"), "info");
			return;
		}

		if (subcommand === "enable" || subcommand === "on" || subcommand === "allow") {
			if (!targetSkill) {
				ctx.ui.notify("Usage: /skill-config enable <skill-name>", "warning");
				return;
			}
			config.skills = config.skills || {};
			config.skills[targetSkill] = true;
			saveConfig(config, configPath, ctx.cwd);
			ctx.ui.notify(`Skill "${targetSkill}" enabled for model auto-invocation`, "info");
			return;
		}

		if (subcommand === "disable" || subcommand === "off" || subcommand === "block") {
			if (!targetSkill) {
				ctx.ui.notify("Usage: /skill-config disable <skill-name>", "warning");
				return;
			}
			config.skills = config.skills || {};
			config.skills[targetSkill] = false;
			saveConfig(config, configPath, ctx.cwd);
			ctx.ui.notify(`Skill "${targetSkill}" set to manual-only (/skill:${targetSkill})`, "info");
			return;
		}

		if (subcommand === "toggle") {
			if (!targetSkill) {
				ctx.ui.notify("Usage: /skill-config toggle <skill-name>", "warning");
				return;
			}
			config.skills = config.skills || {};
			const current = config.skills[targetSkill];
			const next = current === true ? false : true;
			config.skills[targetSkill] = next;
			saveConfig(config, configPath, ctx.cwd);
			ctx.ui.notify(`Skill "${targetSkill}" toggled to: ${next ? "Model Auto" : "Manual Only"}`, "info");
			return;
		}

		if (subcommand === "reset") {
			if (!targetSkill) {
				ctx.ui.notify("Usage: /skill-config reset <skill-name>", "warning");
				return;
			}
			if (config.skills) {
				delete config.skills[targetSkill];
				saveConfig(config, configPath, ctx.cwd);
			}
			ctx.ui.notify(`Skill "${targetSkill}" reset to inherit default policy`, "info");
			return;
		}

		if (subcommand === "enable-all") {
			config.default = "enabled";
			config.skills = {};
			for (const s of getAllKnownSkills()) {
				config.skills[s.name] = true;
			}
			saveConfig(config, configPath, ctx.cwd);
			ctx.ui.notify("All skills enabled for model auto-invocation", "info");
			return;
		}

		if (subcommand === "disable-all") {
			config.default = "disabled";
			config.skills = {};
			for (const s of getAllKnownSkills()) {
				config.skills[s.name] = false;
			}
			saveConfig(config, configPath, ctx.cwd);
			ctx.ui.notify("All skills disabled from model prompt (manual-only)", "info");
			return;
		}

		if (subcommand === "reset-all") {
			config.default = "default";
			config.skills = {};
			saveConfig(config, configPath, ctx.cwd);
			ctx.ui.notify("Reset all skills to default frontmatter behavior", "info");
			return;
		}

		if (subcommand === "default") {
			const policy = targetSkill as "default" | "disabled" | "enabled";
			if (policy === "default" || policy === "disabled" || policy === "enabled") {
				config.default = policy;
				saveConfig(config, configPath, ctx.cwd);
				ctx.ui.notify(`Default policy set to: ${policy}`, "info");
			} else {
				ctx.ui.notify("Usage: /skill-config default <default|disabled|enabled>", "warning");
			}
			return;
		}

		// Direct skill toggle: `/skill-config ponytail`
		const allSkills = getAllKnownSkills();
		if (allSkills.some((s) => s.name === subcommand)) {
			config.skills = config.skills || {};
			const current = config.skills[subcommand];
			const next = current === true ? false : true;
			config.skills[subcommand] = next;
			saveConfig(config, configPath, ctx.cwd);
			ctx.ui.notify(`Skill "${subcommand}" toggled to: ${next ? "Model Auto" : "Manual Only"}`, "info");
			return;
		}

		ctx.ui.notify(`Unknown subcommand or skill: ${subcommand}`, "warning");
	};

	const completionsHandler = (prefix: string) => {
		const subcommands = ["list", "enable", "disable", "toggle", "reset", "enable-all", "disable-all", "reset-all", "default"];
		const allSkills = getAllKnownSkills().map((s) => s.name);

		const parts = prefix.split(/\s+/);
		if (parts.length <= 1) {
			const query = parts[0] || "";
			const matches = [...subcommands, ...allSkills].filter((c) => c.startsWith(query));
			return matches.map((m) => ({ value: m, label: m }));
		}

		const cmd = parts[0].toLowerCase();
		if (["enable", "disable", "toggle", "reset", "on", "off"].includes(cmd)) {
			const skillQuery = parts[1] || "";
			const matches = allSkills.filter((s) => s.startsWith(skillQuery));
			return matches.map((m) => ({ value: `${cmd} ${m}`, label: m }));
		}

		if (cmd === "default") {
			const modes = ["default", "disabled", "enabled"];
			const modeQuery = parts[1] || "";
			return modes.filter((m) => m.startsWith(modeQuery)).map((m) => ({ value: `default ${m}`, label: m }));
		}

		return null;
	};

	pi.registerCommand("skill-config", {
		description: "Configure model invocation for each skill individually",
		getArgumentCompletions: completionsHandler,
		handler: commandHandler,
	});
}
