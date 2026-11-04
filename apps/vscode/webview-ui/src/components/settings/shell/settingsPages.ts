import { AboutPage } from "../about/AboutPage"
import { ModelsPage } from "../models/ModelsPage"
import { DataPage } from "../data/DataPage"
import { LayoutPage } from "../layout/LayoutPage"
import { ToolsPage } from "../tools/ToolsPage"
import { SubagentsPage } from "../subagents/SubagentsPage"
import { AgentPage } from "../agent/AgentPage"
import { Cpu, Database, FlaskConical, GitFork, Info, LayoutPanelLeft, type LucideIcon, Shield, Wrench } from "lucide-react"
import type { ComponentType } from "react"
import type { SettingsPageId } from "../settingsTargets"
import { TemporaryDebugPage } from "./temporaryPages"

/** What the shell renders for each page. Names, gates and order live in `SETTINGS_PAGE_META`. */
export const SETTINGS_PAGE_VIEWS: Record<SettingsPageId, { icon: LucideIcon; Component: ComponentType }> = {
	models: { icon: Cpu, Component: ModelsPage },
	agent: { icon: Shield, Component: AgentPage },
	subagents: { icon: GitFork, Component: SubagentsPage },
	tools: { icon: Wrench, Component: ToolsPage },
	layout: { icon: LayoutPanelLeft, Component: LayoutPage },
	data: { icon: Database, Component: DataPage },
	about: { icon: Info, Component: AboutPage },
	debug: { icon: FlaskConical, Component: TemporaryDebugPage },
}
