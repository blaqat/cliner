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
	await userEvent.click(await canvas.findByRole("button", { name: "Add models" }))
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
		await userEvent.click(await canvasOf(canvasElement).findByRole("button", { name: "Add models" }))
	},
)

export const OpenModelForm = story({ settings: gatewaySettings(), availability: ready }, async ({ canvasElement }) => {
	const canvas = canvasOf(canvasElement)
	const row = await canvas.findByTestId("model-row-sol")
	await userEvent.click(within(row).getAllByRole("button")[0])
	await userEvent.click(await canvas.findByRole("button", { name: /^More/ }))
	await userEvent.click(await canvas.findByRole("button", { name: "Request preview" }))
})

export const UnknownModelForm = story({ settings: gatewaySettings(), availability: ready }, async ({ canvasElement }) => {
	const canvas = canvasOf(canvasElement)
	const row = await canvas.findByTestId("model-row-tuned")
	await userEvent.click(within(row).getAllByRole("button")[0])
	await userEvent.click(await canvas.findByRole("button", { name: "Request preview" }))
})

export const SharedDefaultsOpen = story({ settings: gatewaySettings(), availability: ready }, async ({ canvasElement }) => {
	await userEvent.click(await canvasOf(canvasElement).findByRole("button", { name: /Shared defaults/ }))
})

export const ConnectionForm = story({ settings: gatewaySettings(), availability: ready }, async ({ canvasElement }) => {
	await userEvent.click(await canvasOf(canvasElement).findByRole("button", { name: "Edit connection" }))
})

export const ChooserOpen = story({ settings: gatewaySettings(), availability: ready }, async ({ canvasElement }) => {
	await userEvent.click(await canvasOf(canvasElement).findByRole("button", { name: "Add provider" }))
})

export const LongPage = story({ settings: manyModels(), availability: ready })

export const LongDiscovery = story(
	{ settings: gatewaySettings(), availability: ready, discovery: { gateway: longDiscovery } },
	async ({ canvasElement }) => {
		await userEvent.click(await canvasOf(canvasElement).findByRole("button", { name: "Add models" }))
	},
)

export const RemovalConfirmation = story(
	{ settings: gatewaySettings(), availability: ready, threadDependencies: { mini: ["t1", "t2"] } },
	async ({ canvasElement }) => {
		const canvas = canvasOf(canvasElement)
		const row = await canvas.findByTestId("model-row-mini")
		await userEvent.click(within(row).getAllByRole("button")[0])
		await userEvent.click(await canvas.findByRole("button", { name: "Remove" }))
		await canvas.findByTestId("remove-flow")
	},
)

export const BedrockSetup = story({ settings: gatewaySettings(), availability: ready }, async ({ canvasElement }) => {
	const canvas = canvasOf(canvasElement)
	await userEvent.click(await canvas.findByRole("button", { name: "Add provider" }))
	await userEvent.click(await canvas.findByRole("button", { name: "Amazon Bedrock" }))
})

const azureSettings = (): ModelSettings => {
	const settings = gatewaySettings()
	settings.connections[0] = {
		...settings.connections[0],
		name: "contoso-ai",
		baseUrl: "https://contoso-ai.openai.azure.com/openai/v1",
		auth: { kind: "keychain", secretRef: "settings:v1:connection:gateway:apiKey" },
		headers: [],
		apiFormat: "chat",
		keyHeader: "api-key",
	} as ModelSettings["connections"][number]
	settings.models = [
		{ ...modelRow("sol", "gateway", "gpt-41-prod", "", {}), catalogModelId: "gpt-4.1" },
		modelRow("mini", "gateway", "o4mini-eu", "", {}),
	]
	settings.roles.chat = { modelId: "sol", levelId: "default" }
	settings.roles.background.pick = { modelId: "sol", levelId: "default" }
	return settings
}
const azureHost: FakeHostOptions = {
	settings: azureSettings(),
	availability: { sol: { available: true }, mini: { available: true } },
	secrets: { "settings:v1:connection:gateway:apiKey": "key" },
	metadata: { sol: { contextWindow: 1047576, inputPrice: 2, outputPrice: 8, tools: "yes", images: "yes", reasoning: "no" } },
	openAiCatalog: [
		{ id: "gpt-4.1", name: "GPT-4.1" },
		{ id: "gpt-5", name: "GPT-5" },
		{ id: "o3", name: "o3" },
	],
}

export const AzureConnection = story(azureHost)

export const AzureConnectionEditing = story(azureHost, async ({ canvasElement }) => {
	await userEvent.click(await canvasOf(canvasElement).findByRole("button", { name: "Edit connection" }))
})

export const AzureDeploymentWhichModel = story(azureHost, async ({ canvasElement }) => {
	const row = await canvasOf(canvasElement).findByTestId("model-row-sol")
	await userEvent.click(within(row).getAllByRole("button")[0])
})

export const PastedApimCurl = story({}, async ({ canvasElement }) => {
	const canvas = canvasOf(canvasElement)
	const url = await canvas.findByLabelText("Base URL")
	await userEvent.click(url)
	await userEvent.paste(
		`curl "https://acme-ai.azure-api.net/openai-gw/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21" -H "Ocp-Apim-Subscription-Key: fake-apim-key"`,
	)
	await userEvent.tab()
})
