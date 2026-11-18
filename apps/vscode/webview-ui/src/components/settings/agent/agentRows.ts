import { type AutoApprovalSettings, DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { updateAutoApproveSettings } from "@/components/chat/auto-approve-menu/AutoApproveSettingsAPI"
import { action, preference, stored } from "../shell/rowFactories"
import { updateSetting } from "../utils/settingsHandlers"
export const AGENT_ROWS = [
	preference<AutoApprovalSettings["actions"]>({
		id: "agent.approvals",
		label: "New threads start with",
		description: "Lit runs without asking. Each thread changes its own from the composer.",
		defaultValue: () => DEFAULT_AUTO_APPROVAL_SETTINGS.actions,
		read: (ctx) => ctx.state.autoApprovalSettings?.actions ?? DEFAULT_AUTO_APPROVAL_SETTINGS.actions,
		write: (actions, ctx) =>
			updateAutoApproveSettings({
				...ctx.state.autoApprovalSettings,
				actions,
				version: (ctx.state.autoApprovalSettings?.version ?? 1) + 1,
			}),
	}),
	preference<boolean>({
		id: "agent.multi-root",
		label: "Multi-root workspaces",
		description: "Work across every folder in the window.",
		defaultValue: () => true,
		read: (ctx) => ctx.state.multiRootSetting?.user ?? true,
		write: (value) => updateSetting("multiRootEnabled", value),
	}),
	stored("preferredLanguage", "English", {
		id: "agent.language",
		label: "Language",
		description: "The language Cline answers in.",
		aliases: ["preferred language", "locale"],
	}),
	action({
		id: "agent.about-you",
		label: "About you",
		description:
			"Preferences every thread follows, in any workspace. Sent with every request, so it has a size cap. Project facts belong in a task's notebook.",
		aliases: ["about me", "preferences", "memory", "remember", "personal", "global notes"],
	}),
	stored("enableCheckpointsSetting", true, {
		id: "agent.checkpoints",
		label: "Checkpoints",
		description: "Save progress at key points for easy rollback.",
		aliases: ["restore", "rollback", "undo"],
	}),
	stored("backgroundEditEnabled", false, {
		id: "agent.background-edit",
		label: "Background edit",
		description: "Edit without taking editor focus.",
		aliases: ["focus"],
	}),
	stored("useAutoCondense", true, {
		id: "agent.compact",
		label: "Automatic compaction",
		description: "Compress the conversation when it gets long. Off: only when you ask.",
		aliases: ["auto compact", "condense", "context", "manual"],
	}),
	stored("compactionStrategy", "agentic", {
		id: "agent.compact.strategy",
		parent: "agent.compact",
		label: "Compaction strategy",
		description: "How compaction rewrites the conversation.",
		aliases: ["basic", "agentic"],
		format: (value) => (value === "basic" ? "Basic" : "Agentic"),
		disabledReason: (ctx) => (ctx.state.useAutoCondense === false ? "Only with Automatic compaction on." : undefined),
	}),
	stored("continueAnswerOnActSwitch", true, {
		id: "agent.continue-on-act",
		label: "Carry out the answer when switching to Act",
		description: "Right after an Ask answer, switching to Act also carries it out. Off: switching only changes the mode.",
		aliases: ["ask", "plan", "continue"],
	}),
]
