import { stored, action, state } from "../shell/rowFactories"
const TELEMETRY_LABELS: Record<string, string> = { enabled: "On", disabled: "Off", unset: "Not chosen" }
export const DATA_ROWS = [
	action({
		id: "data.history",
		label: "History",
		description: "Export threads from History, or clear history and checkpoints. Settings and notebook stay.",
	}),
	action({ id: "data.reset", label: "Reset all extension settings", description: "Return extension state to its defaults." }),
	state({
		id: "data.reporting.otel",
		parent: "data.reporting",
		label: "OpenTelemetry",
		description: "Your organization configures export to its collector. Ask your admin to change it.",
		managedKeys: ["openTelemetryEnabled"],
	}),
	stored<string>("telemetrySetting", "unset", {
		id: "data.reporting",
		label: "Error and usage reporting",
		description: "Help improve Cline. No code, prompts or personal information are ever sent.",
		aliases: ["telemetry", "privacy", "analytics"],
		managedKeys: ["telemetrySetting"],
		format: (value) => TELEMETRY_LABELS[value] ?? value,
	}),
]
