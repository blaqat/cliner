import { updateAutoApproveSettings } from "@/components/chat/auto-approve-menu/AutoApproveSettingsAPI"
import { stored, preference } from "../shell/rowFactories"
import { detectMetaKeyChar, detectOS } from "@/utils/platformUtils"
import { DEFAULT_TOAST_SECONDS } from "../../toasts/threadToastRules"
export const LAYOUT_ROWS = [
	preference<boolean>({
		id: "layout.toasts.system",
		parent: "layout.toasts",
		label: "System notifications",
		description: "System notifications for approvals and completed tasks.",
		defaultValue: () => false,
		read: (ctx) => ctx.state.autoApprovalSettings?.enableNotifications ?? false,
		write: (enableNotifications, ctx) =>
			updateAutoApproveSettings({
				...ctx.state.autoApprovalSettings,
				enableNotifications,
				version: ctx.state.autoApprovalSettings.version + 1,
			}),
	}),
	stored("oneViewEnabled", false, {
		id: "layout.one-view",
		label: "Layout",
		description: "",
		aliases: ["list", "side bar", "tab bar", "classic"],
	}),
	stored("enterSendsAs", "steer", {
		id: "layout.enter",
		label: "While working, Enter sends as",
		description: (ctx) =>
			`${detectMetaKeyChar(ctx.state.platform)}+Enter does the other one. ${detectOS(ctx.state.platform) === "mac" ? "⌥" : "Alt"}+Enter sends as an aside.`,
		aliases: ["steer", "interject"],
		format: (value) => (value === "interject" ? "Interject" : "Steer"),
	}),
	stored("threadToastsEnabled", true, {
		id: "layout.toasts",
		label: "Toasts",
		description: "When a thread you're not viewing finishes or needs you.",
		aliases: ["notifications", "in-app"],
	}),
	stored("threadToastSeconds", DEFAULT_TOAST_SECONDS, {
		id: "layout.toasts.seconds",
		parent: "layout.toasts",
		label: "Completion toast seconds",
		description: "Hovering pauses it. While VS Code is in the background, the timer waits.",
		aliases: ["duration"],
		disabledReason: (ctx) => (ctx.state.threadToastsEnabled === false ? "Only with Toasts on." : undefined),
	}),
	stored("showFeatureTips", false, {
		id: "layout.tips",
		label: "Feature tips",
		description: "Rotating tips while Cline is thinking.",
	}),
]
