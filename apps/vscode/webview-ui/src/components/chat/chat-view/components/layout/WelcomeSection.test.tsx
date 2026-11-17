import { BannerActionType } from "@shared/cline/banner"
import { render, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createFakeHost, type FakeHost, gatewaySettings } from "@/components/settings/models/modelsPage.fixture"
import { WelcomeSection } from "./WelcomeSection"

const mocks = vi.hoisted(() => ({
	host: {} as Record<string, unknown>,
	state: {} as Record<string, unknown>,
	onAction: undefined as undefined | ((action: unknown) => void),
}))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/context/ClineAuthContext", () => ({ useClineAuth: () => ({ clineUser: undefined }) }))
vi.mock("@/hooks/useClinePassPromo", () => ({
	useClinePassPromo: () => ({ isClinePassEnabled: false, isUsingClinePass: false }),
}))
vi.mock("@/components/common/BannerCarousel", () => ({ default: () => null }))
vi.mock("@/components/common/WhatsNewModal", () => ({
	default: ({ onBannerAction }: { onBannerAction: (action: unknown) => void }) => {
		mocks.onAction = onBannerAction
		return null
	},
}))
vi.mock("@/components/inbox/InboxList", () => ({ default: () => null }))
vi.mock("@/components/welcome/HomeHeader", () => ({ default: () => null }))
vi.mock("@/components/welcome/HomeSearchBar", () => ({ HomeSearchBar: () => null }))
vi.mock("@/components/welcome/SuggestedTasks", () => ({ SuggestedTasks: () => null }))
vi.mock("@/components/worktrees/CreateWorktreeForm", () => ({ default: () => null }))
vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: new Proxy({}, { get: (_target, name: string) => mocks.host[name] }),
	AccountServiceClient: {},
	StateServiceClient: {},
	UiServiceClient: {},
	WorktreeServiceClient: { listWorktrees: () => Promise.resolve({ worktrees: [] }) },
}))

let host: FakeHost
const open = () => {
	render(
		<WelcomeSection
			{...({ showAnnouncement: false, hideAnnouncement: vi.fn(), shouldShowQuickWins: false, taskHistory: [] } as never)}
		/>,
	)
	return mocks.onAction as (action: unknown) => void
}

describe("home banners with the new store in use", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		host = createFakeHost({ settings: gatewaySettings() })
		mocks.host = host.client
		mocks.state = {
			modelSettings: host.state(),
			currentTaskItem: undefined,
			navigateToSettings: vi.fn(),
			navigateToSettingsModelPicker: vi.fn(),
			openRouterModels: {},
			banners: [],
			welcomeBanners: [],
		}
	})
	it("Set model runs the banner's model through the new store", async () => {
		open()({ action: BannerActionType.SetModel, arg: "vendor/banner-model" })
		await waitFor(() => expect(mocks.state.navigateToSettings).toHaveBeenCalledWith("models"))
		const { settings } = host.state()
		const chat = settings.models.find((model) => model.id === settings.roles.chat?.modelId)
		expect(chat?.upstreamId).toBe("vendor/banner-model")
		expect(settings.connections.find((c) => c.id === chat?.connectionId)).toMatchObject({ providerId: "cline" })
	})
	it("Show API settings opens Models and writes nothing", () => {
		const before = host.state().settings.revision
		open()({ action: BannerActionType.ShowApiSettings, arg: "openrouter" })
		expect(mocks.state.navigateToSettings).toHaveBeenCalledWith("models")
		expect(host.state().settings.revision).toBe(before)
	})
})
