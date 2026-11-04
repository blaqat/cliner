import type { Meta, StoryObj } from "@storybook/react-vite"
import { userEvent, within } from "storybook/test"
import { modelSettingsFixture } from "@/components/models/modelSelector.fixture"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import { SettingsShell } from "./SettingsShell"

/**
 * The seven-page Settings shell. Real builds show it only when `ExtensionState.modelSettings` is
 * present; here it renders directly. Pages hold today's controls until Phases 6 and 7.
 */
const changedState = {
	modelSettings: modelSettingsFixture(),
	enableCheckpointsSetting: false,
	threadToastSeconds: 9,
	terminalReuseEnabled: false,
	enterSendsAs: "interject" as const,
	availableTerminalProfiles: [{ id: "default", name: "Default" }],
}

const meta: Meta<typeof SettingsShell> = {
	title: "Views/Settings/SettingsShell",
	component: SettingsShell,
	parameters: { layout: "fullscreen" },
	args: { onDone: () => {} },
	decorators: [createStorybookDecorator(changedState, "max-w-none")],
}

export default meta
type Story = StoryObj<typeof SettingsShell>

const canvasOf = (canvasElement: HTMLElement) => within(canvasElement)

export const Default: Story = {}

export const AgentPage: Story = { args: { navigationRequest: { target: "agent", requestId: 1 } } }

export const SearchHits: Story = {
	play: async ({ canvasElement }) => {
		await userEvent.type(canvasOf(canvasElement).getByLabelText("Search settings"), "terminal")
	},
}

export const NoResults: Story = {
	play: async ({ canvasElement }) => {
		await userEvent.type(canvasOf(canvasElement).getByLabelText("Search settings"), "zzzz")
	},
}

export const ChangedOn: Story = {
	play: async ({ canvasElement }) => {
		await userEvent.click(canvasOf(canvasElement).getByRole("button", { name: /^Changed/ }))
	},
}

export const AdvancedOpenFromSearch: Story = {
	play: async ({ canvasElement }) => {
		const canvas = canvasOf(canvasElement)
		await userEvent.type(canvas.getByLabelText("Search settings"), "reuse")
		await userEvent.click(canvas.getByRole("button", { name: "Reuse terminals" }))
	},
}

export const Managed: Story = {
	args: { navigationRequest: { target: "data", requestId: 2 } },
	decorators: [
		createStorybookDecorator(
			{ ...changedState, telemetrySetting: "disabled", remoteConfigSettings: { telemetrySetting: "disabled" } },
			"max-w-none",
			{ activeOrganization: { active: true, memberId: "1", name: "Acme Corp", organizationId: "1", roles: ["member"] } },
		),
	],
}
