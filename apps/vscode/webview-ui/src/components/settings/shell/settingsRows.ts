import { ABOUT_ROWS } from "../about/aboutRows"
import { DATA_ROWS } from "../data/dataRows"
import { LAYOUT_ROWS } from "../layout/layoutRows"
import { MODELS_ROWS } from "../models/modelsRows"
import { TOOLS_ROWS } from "../tools/toolsRows"
import { SUBAGENTS_ROWS } from "../subagents/subagentsRows"
import { AGENT_ROWS } from "../agent/agentRows"
import { action } from "./rowFactories"
import type { SettingsRow } from "./settingsRegistry"
/**
 * Every row search, Changed and navigation can reach. Values stay in their existing stores: this
 * only says how to read, write and reset them. A row here must exist on its page.
 */
export const SETTINGS_ROWS: readonly SettingsRow[] = [
	...MODELS_ROWS,

	...AGENT_ROWS,

	...SUBAGENTS_ROWS,

	...TOOLS_ROWS,

	...LAYOUT_ROWS,

	...DATA_ROWS,

	...ABOUT_ROWS,

	action({
		id: "debug.tools",
		label: "Debug tools",
		description: "Reset workspace, global and onboarding state.",
	}),
]
