// Extracted from classic src/core/controller/index.ts (see origin/main)
//
// Standalone function to build ExtensionState from a Controller instance.
// This allows the SdkController to reuse the classic state-building logic
// without inheriting the entire classic Controller implementation.

import { isModelToolEnabledGlobally, readCompactionStrategyGlobally } from "@cline/core"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import type { ExtensionState, Platform } from "@shared/ExtensionMessage"
import { maskTerminalEnvironmentScope } from "@shared/terminal-environment"
import { ClineEnv } from "@/config"
import { ExtensionRegistryInfo } from "@/registry"
import { useModelSettings } from "@/sdk/model-settings/background"
import { readModelSettingsState } from "@/sdk/model-settings/host-settings"
import { modelSettingsRolloutEnabled } from "@/sdk/model-settings/rollout"
import { BannerService } from "@/services/banner/BannerService"
import { featureFlagsService } from "@/services/feature-flags"
import { getDistinctId } from "@/services/logging/distinctId"
import { getExtensionVariant } from "@/services/telemetry/rollout-metadata"
import { getLatestAnnouncementId } from "@/utils/announcements"
import { getClineOnboardingModels } from "../models/getClineOnboardingModels"
import { buildStateTaskHistory } from "./stateTaskHistory"

/**
 * Builds the ExtensionState object to push to the webview.
 * Extracted from the classic Controller.getStateToPostToWebview().
 */
export async function getStateToPostToWebview(controller: {
	deferTaskHistory?: boolean
	task?: any
	stateManager: any
	mcpHub?: any
	backgroundCommandRunning?: boolean
	backgroundCommandTaskId?: string
	foregroundCommandRunning?: boolean
	workspaceManager?: any
	checkpointRestoreInput?: ExtensionState["checkpointRestoreInput"]
	isRemoteConfigAvailable?: boolean
	currentRemoteConfigRevision?: number
}): Promise<ExtensionState> {
	const stateManager = controller.stateManager

	// Get API configuration from cache for immediate access
	const onboardingModels = getClineOnboardingModels()
	const apiConfiguration = stateManager.getApiConfiguration()
	const lastShownAnnouncementId = stateManager.getGlobalStateKey("lastShownAnnouncementId")
	const taskHistory = stateManager.getGlobalStateKey("taskHistory")
	const autoApprovalSettings = stateManager.getGlobalSettingsKey("autoApprovalSettings")
	const browserSettings = stateManager.getGlobalSettingsKey("browserSettings")
	const preferredLanguage = stateManager.getGlobalSettingsKey("preferredLanguage")
	const mode = stateManager.getGlobalSettingsKey("mode")
	const useAutoCondense = stateManager.getGlobalSettingsKey("useAutoCondense")
	const compactionStrategy = readCompactionStrategyGlobally()
	const webSearchEnabled = isModelToolEnabledGlobally("web_search")
	const subagentsEnabled = stateManager.getGlobalSettingsKey("subagentsEnabled")
	const userInfo = stateManager.getGlobalStateKey("userInfo")
	const mcpMarketplaceEnabled = stateManager.getGlobalStateKey("mcpMarketplaceEnabled")
	const mcpDisplayMode = stateManager.getGlobalStateKey("mcpDisplayMode")
	const telemetrySetting = stateManager.getGlobalSettingsKey("telemetrySetting")
	const planActSeparateModelsSetting = stateManager.getGlobalSettingsKey("planActSeparateModelsSetting")
	const enableCheckpointsSetting = stateManager.getGlobalSettingsKey("enableCheckpointsSetting")
	const globalClineRulesToggles = stateManager.getGlobalStateKey("globalClineRulesToggles")
	const globalWorkflowToggles = stateManager.getGlobalStateKey("globalWorkflowToggles")
	const globalSkillsToggles = stateManager.getGlobalStateKey("globalSkillsToggles")
	const localSkillsToggles = stateManager.getWorkspaceStateKey("localSkillsToggles")
	const remoteRulesToggles = stateManager.getGlobalStateKey("remoteRulesToggles")
	const remoteWorkflowToggles = stateManager.getGlobalStateKey("remoteWorkflowToggles")
	const shellIntegrationTimeout = stateManager.getGlobalSettingsKey("shellIntegrationTimeout")
	const terminalReuseEnabled = stateManager.getGlobalStateKey("terminalReuseEnabled")
	const vscodeTerminalExecutionMode = stateManager.getGlobalStateKey("vscodeTerminalExecutionMode")
	const defaultTerminalProfile = stateManager.getGlobalSettingsKey("defaultTerminalProfile")
	const isNewUser = stateManager.getGlobalStateKey("isNewUser")
	const welcomeViewCompleted = !!stateManager.getGlobalStateKey("welcomeViewCompleted")

	const mcpResponsesCollapsed = stateManager.getGlobalStateKey("mcpResponsesCollapsed")
	const favoritedModelIds = stateManager.getGlobalStateKey("favoritedModelIds")
	const lastDismissedInfoBannerVersion = stateManager.getGlobalStateKey("lastDismissedInfoBannerVersion") || 0
	const lastDismissedModelBannerVersion = stateManager.getGlobalStateKey("lastDismissedModelBannerVersion") || 0
	const lastDismissedCliBannerVersion = stateManager.getGlobalStateKey("lastDismissedCliBannerVersion") || 0
	const dismissedBanners = stateManager.getGlobalStateKey("dismissedBanners")
	const showFeatureTips = stateManager.getGlobalSettingsKey("showFeatureTips")

	const localClineRulesToggles = stateManager.getWorkspaceStateKey("localClineRulesToggles")
	const localWindsurfRulesToggles = stateManager.getWorkspaceStateKey("localWindsurfRulesToggles")
	const localCursorRulesToggles = stateManager.getWorkspaceStateKey("localCursorRulesToggles")
	const localAgentsRulesToggles = stateManager.getWorkspaceStateKey("localAgentsRulesToggles")
	const workflowToggles = stateManager.getWorkspaceStateKey("workflowToggles")

	const currentTaskItem =
		!controller.deferTaskHistory && controller.task?.taskId
			? (taskHistory || []).find((item: any) => item.id === controller.task?.taskId)
			: undefined
	const clineMessages = [...(controller.task?.messageStateHandler?.getClineMessages?.() || [])]
	const checkpointRestoreInput = controller.checkpointRestoreInput

	const processedTaskHistory = controller.deferTaskHistory
		? (taskHistory ?? [])
		: buildStateTaskHistory(
				(taskHistory || []).filter((item: any) => item.ts && item.task).sort((a: any, b: any) => b.ts - a.ts),
				[controller.task?.taskId],
			)

	const latestAnnouncementId = getLatestAnnouncementId()
	const shouldShowAnnouncement = lastShownAnnouncementId !== latestAnnouncementId
	const platform = process.platform as Platform
	const distinctId = getDistinctId()
	const version = ExtensionRegistryInfo.version
	const clineConfig = ClineEnv.config()
	const environment = clineConfig.environment
	const banners = BannerService.get().getActiveBanners() ?? []
	const welcomeBanners = BannerService.get().getWelcomeBanners() ?? []

	// Check OpenAI Codex authentication status
	let openAiCodexIsAuthenticated = false
	try {
		const { openAiCodexOAuthManager } = await import("@/integrations/openai-codex/oauth")
		openAiCodexIsAuthenticated = await openAiCodexOAuthManager.isAuthenticated()
	} catch {
		// Codex OAuth not available
	}

	return {
		...(useModelSettings(stateManager) ? { modelSettings: await readModelSettingsState(stateManager) } : {}),
		// Not gated on the journal: a failed first migration has no modelSettings, and this is how it can be retried.
		...(modelSettingsRolloutEnabled()
			? { modelSettingsMigrationStatus: stateManager.getModelSettingsMigrationStatus() }
			: {}),
		version,
		extensionVariant: getExtensionVariant(),
		apiConfiguration,
		currentTaskItem,
		clineMessages,
		checkpointRestoreInput,
		autoApprovalSettings,
		browserSettings,
		preferredLanguage,
		mode,
		useAutoCondense,
		compactionStrategy,
		webSearchEnabled,
		subagentsEnabled,
		subagentsMaxConcurrent: stateManager.getGlobalSettingsKey("subagentsMaxConcurrent"),
		subagentsAllowWrite: stateManager.getGlobalSettingsKey("subagentsAllowWrite"),
		subagentsAllowCommands: stateManager.getGlobalSettingsKey("subagentsAllowCommands"),
		subagentsAllowMcp: stateManager.getGlobalSettingsKey("subagentsAllowMcp"),
		subagentsAllowWeb: stateManager.getGlobalSettingsKey("subagentsAllowWeb"),
		threadTitlesEnabled: stateManager.getGlobalStateKey("threadTitlesEnabled"),
		// Names + masked placeholders only; values come from revealTerminalEnvironment.
		terminalEnvironment: {
			global: maskTerminalEnvironmentScope(stateManager.getGlobalStateKey("terminalEnvironment")),
			workspace: maskTerminalEnvironmentScope(stateManager.getWorkspaceStateKey("terminalEnvironment")),
		},

		userInfo,
		mcpMarketplaceEnabled,
		mcpDisplayMode,
		telemetrySetting,
		planActSeparateModelsSetting,
		enableCheckpointsSetting: enableCheckpointsSetting ?? true,
		platform,
		environment,
		distinctId,
		globalClineRulesToggles: globalClineRulesToggles || {},
		localClineRulesToggles: localClineRulesToggles || {},
		localWindsurfRulesToggles: localWindsurfRulesToggles || {},
		localCursorRulesToggles: localCursorRulesToggles || {},
		localAgentsRulesToggles: localAgentsRulesToggles || {},
		localWorkflowToggles: workflowToggles || {},
		globalWorkflowToggles: globalWorkflowToggles || {},
		globalSkillsToggles: globalSkillsToggles || {},
		localSkillsToggles: localSkillsToggles || {},
		remoteRulesToggles,
		remoteWorkflowToggles,
		focusChainSettings: stateManager.getGlobalSettingsKey("focusChainSettings"),
		openTelemetrySettings: {
			openTelemetryEnabled: stateManager.getGlobalSettingsKey("openTelemetryEnabled"),
			openTelemetryMetricsExporter: stateManager.getGlobalSettingsKey("openTelemetryMetricsExporter"),
			openTelemetryLogsExporter: stateManager.getGlobalSettingsKey("openTelemetryLogsExporter"),
			openTelemetryTracesExporter: stateManager.getGlobalSettingsKey("openTelemetryTracesExporter"),
			openTelemetryOtlpProtocol: stateManager.getGlobalSettingsKey("openTelemetryOtlpProtocol"),
			openTelemetryOtlpEndpoint: stateManager.getGlobalSettingsKey("openTelemetryOtlpEndpoint"),
			openTelemetryOtlpMetricsProtocol: stateManager.getGlobalSettingsKey("openTelemetryOtlpMetricsProtocol"),
			openTelemetryOtlpMetricsEndpoint: stateManager.getGlobalSettingsKey("openTelemetryOtlpMetricsEndpoint"),
			openTelemetryOtlpLogsProtocol: stateManager.getGlobalSettingsKey("openTelemetryOtlpLogsProtocol"),
			openTelemetryOtlpLogsEndpoint: stateManager.getGlobalSettingsKey("openTelemetryOtlpLogsEndpoint"),
			openTelemetryMetricExportInterval: stateManager.getGlobalSettingsKey("openTelemetryMetricExportInterval"),
			openTelemetryOtlpInsecure: stateManager.getGlobalSettingsKey("openTelemetryOtlpInsecure"),
			openTelemetryLogBatchSize: stateManager.getGlobalSettingsKey("openTelemetryLogBatchSize"),
			openTelemetryLogBatchTimeout: stateManager.getGlobalSettingsKey("openTelemetryLogBatchTimeout"),
			openTelemetryLogMaxQueueSize: stateManager.getGlobalSettingsKey("openTelemetryLogMaxQueueSize"),
		},
		shellIntegrationTimeout,
		terminalReuseEnabled,
		vscodeTerminalExecutionMode,
		defaultTerminalProfile,
		isNewUser,
		welcomeViewCompleted,
		onboardingModels,
		mcpResponsesCollapsed,
		taskHistory: processedTaskHistory,
		sessionStatuses: {},
		subagentCounts: {},
		enterSendsAs: stateManager.getGlobalSettingsKey("enterSendsAs") ?? "steer",
		promptStash: stateManager.getGlobalStateKey("promptStash") ?? [],
		shouldShowAnnouncement,
		favoritedModelIds,
		backgroundCommandRunning: controller.backgroundCommandRunning ?? false,
		backgroundCommandTaskId: controller.backgroundCommandTaskId,
		foregroundCommandRunning: controller.foregroundCommandRunning ?? false,
		workspaceRoots: controller.workspaceManager?.getRoots?.() ?? [],
		primaryRootIndex: controller.workspaceManager?.getPrimaryIndex?.() ?? 0,
		isMultiRootWorkspace: (controller.workspaceManager?.getRoots?.()?.length ?? 0) > 1,
		multiRootSetting: {
			user: stateManager.getGlobalStateKey("multiRootEnabled"),
			featureFlag: true,
		},
		worktreesEnabled: {
			user: stateManager.getGlobalSettingsKey("worktreesEnabled"),
			featureFlag: featureFlagsService.getWorktreesEnabled(),
		},
		hooksEnabled: getHooksEnabledSafe(stateManager.getGlobalSettingsKey("hooksEnabled")),
		lastDismissedInfoBannerVersion,
		lastDismissedModelBannerVersion,
		remoteConfigSettings: (() => {
			const remote = stateManager.getRemoteConfigSettings?.()
			if (!remote) return remote
			const masked = { ...remote }
			for (const key of ["openTelemetryOtlpHeaders", "otlpMetricsHeaders", "otlpLogsHeaders"] as const) {
				if (masked[key]) masked[key] = Object.fromEntries(Object.keys(masked[key]!).map((name) => [name, "********"]))
			}
			return masked
		})(),
		remoteConfigRevision: controller.currentRemoteConfigRevision ?? 0,
		lastDismissedCliBannerVersion,
		dismissedBanners,
		backgroundEditEnabled: stateManager.getGlobalSettingsKey("backgroundEditEnabled"),
		optOutOfRemoteConfig: stateManager.getGlobalSettingsKey("optOutOfRemoteConfig"),
		remoteConfigAvailable: controller.isRemoteConfigAvailable ?? false,
		showFeatureTips,
		threadToastsEnabled: stateManager.getGlobalSettingsKey("threadToastsEnabled"),
		threadToastSeconds: stateManager.getGlobalSettingsKey("threadToastSeconds"),
		continueAnswerOnActSwitch: stateManager.getGlobalSettingsKey("continueAnswerOnActSwitch"),
		oneViewEnabled: stateManager.getGlobalSettingsKey("oneViewEnabled"),
		banners,
		welcomeBanners,
		openAiCodexIsAuthenticated,
	} as ExtensionState
}
