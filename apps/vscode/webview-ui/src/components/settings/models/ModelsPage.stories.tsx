import type { ModelSettings } from "@shared/model-settings"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { userEvent, within } from "storybook/test"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import { ModelsServiceClient } from "@/services/grpc-client"
import { SettingsShell } from "../shell/SettingsShell"
import { createFakeHost, type FakeHostOptions, gatewaySettings, levelsUpTo, modelRow } from "./modelsPage.fixture"

/**
 * The Models setup page against a fake host. Nothing here talks to a real extension host, and the
 * model names and prices are made up. Real builds only show this with `modelSettings` published.
 */
const ready = { sol: { available: true }, g54: { available: true }, mini: { available: true }, tuned: { available: true } }

const installHost = (options: FakeHostOptions = {}) => {
	const host = createFakeHost(options)
	Object.assign(ModelsServiceClient, host.client)
	return { modelSettings: host.state(), remoteConfigSettings: {} }
}

const story = (options: FakeHostOptions, play?: Story["play"]): Story => ({
	decorators: [
		(Story) => {
			const overrides = installHost(options)
			return createStorybookDecorator(overrides, "max-w-none")(Story)
		},
	],
	play,
})

const meta: Meta<typeof SettingsShell> = {
	title: "Views/Settings/ModelsPage",
	component: SettingsShell,
	parameters: { layout: "fullscreen" },
	args: { onDone: () => {} },
}

export default meta
type Story = StoryObj<typeof SettingsShell>

const canvasOf = (canvasElement: HTMLElement) => within(canvasElement)

const manyModels = (): ModelSettings => {
	const settings = gatewaySettings()
	for (let index = 0; index < 24; index++) {
		settings.models.push(
			modelRow(`extra-${index}`, "gateway", `team-model-${index}`, "", {
				reasoning: "yes",
				levels: levelsUpTo(3),
				contextWindow: 128000,
			}),
		)
	}
	return settings
}

const longDiscovery = {
	status: "ok" as const,
	models: Array.from({ length: 60 }, (_, index) => ({
		upstreamId: `vendor/model-${index}`,
		name: `vendor/model-${index}`,
		classification: "unknown" as const,
		source: "discovered" as const,
	})),
}

export const FirstVisit = story({})

export const GatewayWithFourModels = story({ settings: gatewaySettings(), availability: ready })

export const AddingFromModels = story({ settings: gatewaySettings(), availability: ready }, async ({ canvasElement }) => {
	const canvas = canvasOf(canvasElement)
	await userEvent.click(await canvas.findByRole("button", { name: "Add model" }))
	const list = await canvas.findByTestId("add-models-list")
	await userEvent.click(await within(list).findByRole("checkbox", { name: /gpt-5\.6-nano/ }))
	await userEvent.click(await within(list).findByRole("checkbox", { name: /qwen3-coder/ }))
})

export const NoListConnection = story(
	{
		settings: gatewaySettings(),
		availability: ready,
		discovery: { gateway: { status: "no-list", manualEntry: true, models: [] } },
	},
	async ({ canvasElement }) => {
		await userEvent.click(await canvasOf(canvasElement).findByRole("button", { name: "Add model" }))
	},
)

export const OpenModelForm = story({ settings: gatewaySettings(), availability: ready }, async ({ canvasElement }) => {
	const canvas = canvasOf(canvasElement)
	const row = await canvas.findByTestId("model-row-sol")
	await userEvent.click(within(row).getAllByRole("button")[0])
	await userEvent.click(await canvas.findByRole("button", { name: /^More/ }))
	await userEvent.click(await canvas.findByRole("button", { name: /Preview the request/ }))
})

export const UnknownModelForm = story({ settings: gatewaySettings(), availability: ready }, async ({ canvasElement }) => {
	const canvas = canvasOf(canvasElement)
	const row = await canvas.findByTestId("model-row-tuned")
	await userEvent.click(within(row).getAllByRole("button")[0])
	await userEvent.click(await canvas.findByRole("button", { name: "What happens" }))
})

export const SharedDefaultsOpen = story({ settings: gatewaySettings(), availability: ready }, async ({ canvasElement }) => {
	await userEvent.click(await canvasOf(canvasElement).findByRole("button", { name: /Shared defaults/ }))
})

export const ConnectionForm = story({ settings: gatewaySettings(), availability: ready }, async ({ canvasElement }) => {
	await userEvent.click(await canvasOf(canvasElement).findByRole("button", { name: "Edit connection" }))
})

export const ChooserOpen = story({ settings: gatewaySettings(), availability: ready }, async ({ canvasElement }) => {
	await userEvent.click(await canvasOf(canvasElement).findByRole("button", { name: "Add a model from another provider" }))
})

export const LongPage = story({ settings: manyModels(), availability: ready })

export const LongDiscovery = story(
	{ settings: gatewaySettings(), availability: ready, discovery: { gateway: longDiscovery } },
	async ({ canvasElement }) => {
		await userEvent.click(await canvasOf(canvasElement).findByRole("button", { name: "Add model" }))
	},
)

export const DeleteDependencies = story(
	{ settings: gatewaySettings(), availability: ready, threadDependencies: { mini: ["t1", "t2"] } },
	async ({ canvasElement }) => {
		const canvas = canvasOf(canvasElement)
		const row = await canvas.findByTestId("model-row-mini")
		await userEvent.click(within(row).getAllByRole("button")[0])
		await userEvent.click(await canvas.findByRole("button", { name: "Remove" }))
		const flow = await canvas.findByTestId("remove-flow")
		await userEvent.click(within(flow).getByRole("button", { name: "Remove" }))
	},
)

export const BedrockSetup = story({ settings: gatewaySettings(), availability: ready }, async ({ canvasElement }) => {
	const canvas = canvasOf(canvasElement)
	await userEvent.click(await canvas.findByRole("button", { name: "Add a model from another provider" }))
	await userEvent.click(await canvas.findByRole("button", { name: "Amazon Bedrock" }))
})
