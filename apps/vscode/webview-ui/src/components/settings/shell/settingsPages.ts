import { Cpu, Database, FlaskConical, GitFork, Info, LayoutPanelLeft, type LucideIcon, Shield, Wrench } from "lucide-react"
import type { ComponentType } from "react"
import type { SettingsPageId } from "../settingsTargets"
import {
	TemporaryAboutPage,
	TemporaryAgentPage,
	TemporaryDataPage,
	TemporaryDebugPage,
	TemporaryLayoutPage,
	TemporaryModelsPage,
	TemporarySubagentsPage,
	TemporaryToolsPage,
} from "./temporaryPages"

/** What the shell renders for each page. Names, gates and order live in `SETTINGS_PAGE_META`. */
export const SETTINGS_PAGE_VIEWS: Record<SettingsPageId, { icon: LucideIcon; Component: ComponentType }> = {
	models: { icon: Cpu, Component: TemporaryModelsPage },
	agent: { icon: Shield, Component: TemporaryAgentPage },
	subagents: { icon: GitFork, Component: TemporarySubagentsPage },
	tools: { icon: Wrench, Component: TemporaryToolsPage },
	layout: { icon: LayoutPanelLeft, Component: TemporaryLayoutPage },
	data: { icon: Database, Component: TemporaryDataPage },
	about: { icon: Info, Component: TemporaryAboutPage },
	debug: { icon: FlaskConical, Component: TemporaryDebugPage },
}
