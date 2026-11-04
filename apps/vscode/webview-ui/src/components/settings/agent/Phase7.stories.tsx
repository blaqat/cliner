import type { Meta, StoryObj } from "@storybook/react-vite"
import { SettingsShell } from "../shell/SettingsShell"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import { modelSettingsFixture } from "@/components/models/modelSelector.fixture"
const meta: Meta<typeof SettingsShell> = {
	title: "Views/Settings/Phase7",
	component: SettingsShell,
	parameters: { layout: "fullscreen" },
	args: { onDone: () => {} },
	decorators: [
		createStorybookDecorator(
			{
				modelSettings: modelSettingsFixture(),
				version: "Phase 7 mock",
				preferredLanguage: "English",
				remoteConfigSettings: {},
				multiRootSetting: { user: true, featureFlag: true },
				hooksEnabled: true,
				webSearchEnabled: true,
				useAutoCondense: true,
				compactionStrategy: "agentic",
				enterSendsAs: "steer",
				availableTerminalProfiles: [{ id: "default", name: "Default" }],
			},
			"max-w-none",
		),
	],
}
export default meta
type Story = StoryObj<typeof SettingsShell>
export const Agent: Story = { args: { navigationRequest: { target: "agent", requestId: 1 } } }
export const Subagents: Story = { args: { navigationRequest: { target: "subagents", requestId: 1 } } }
export const Layout: Story = { args: { navigationRequest: { target: "layout", requestId: 1 } } }
export const Tools: Story = { args: { navigationRequest: { target: "tools", requestId: 1 } } }
export const Data: Story = { args: { navigationRequest: { target: "data", requestId: 1 } } }
export const About: Story = { args: { navigationRequest: { target: "about", requestId: 1 } } }
