// Replaces classic src/core/controller/index.ts (see origin/main)
//
// The SDK-backed Controller. It provides the same interface as the classic
// Controller but delegates session lifecycle (initTask, askResponse,
// cancelTask, …) to the Cline SDK (@cline/core) and bridges SDK events to
// the webview's gRPC streams.

import { existsSync } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import {
	type CompareCheckpointResult,
	type CoreSessionEvent,
	createRestoredCheckpointMetadata,
	createUserInstructionConfigService,
	ensureChatWorkspace,
	findCheckpointForRun,
	getProviderAuthStorageId,
	getUserRunSpan,
	type PreparedRemoteConfigCoreIntegration,
	readSessionCheckpointHistory,
	resolveDefaultMcpSettingsPath,
	type SessionHistoryRecord,
	setTelemetryOptOutGlobally,
	type UserInstructionConfigService,
} from "@cline/core"
import { createSessionId, formatDisplayUserInput, type RemoteConfig, type RemoteConfigBundle } from "@cline/shared"
import type { ApiConfiguration } from "@shared/api"
import { type TaskApiSelection, taskApiSelectionsEqual } from "@shared/api-profiles"
import type { ChatContent } from "@shared/ChatContent"
import { CLINE_ACCOUNT_AUTH_ERROR_MESSAGE } from "@shared/ClineAccount"
import {
	authorizedThreadIds,
	type ComposerProvenance,
	type MessageLinkRef,
	messageLinkRefs,
	normalizeProvenance,
} from "@shared/composer-provenance"
import { mentionRegexGlobal } from "@shared/context-mentions"
import type { ClineApiReqInfo, ClineMessage, ClineSay, ExtensionState, TurnPhase } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { buildMessageLinkPath, type MessageLinkAnchor } from "@shared/message-links"
import { formatMessageReference, prependMessageReferences } from "@shared/message-references"
import type { AssignApiProfileRequest } from "@shared/proto/cline/models"
import { DeleteAllTaskHistoryCount, type GetTaskHistoryRequest, TaskHistoryArray, TaskResponse } from "@shared/proto/cline/task"
import type { NotebookActionRequest } from "@shared/proto/cline/task_group"
import type { ThreadWorktreeActionRequest } from "@shared/proto/cline/worktree"
import type { Settings } from "@shared/storage/state-keys"
import { isOpenaiReasoningEffort, type Mode } from "@shared/storage/types"
import type { TelemetrySetting } from "@shared/TelemetrySetting"
import type {
	HistorySearchHit,
	HistorySearchThread,
	NotebookChange,
	NotebookNoteMeta,
	TaskGroupSummary,
	TaskGroupThreadRow,
	TaskTag,
} from "@shared/task-groups"
import type { ThreadWorktreeSettings, WorktreeActionResult } from "@shared/thread-worktrees"
import { extractTicketTags } from "@shared/ticket-tags"
import type { WalkthroughScope } from "@shared/Walkthrough"
import type { ClineCheckpointRestore } from "@shared/WebviewMessage"
import chokidar, { type FSWatcher } from "chokidar"
import { refreshClineRulesToggles } from "@/core/context/instructions/user-instructions/cline-rules"
import { refreshWorkflowToggles } from "@/core/context/instructions/user-instructions/workflows"
import {
	captureTaskApiSelection,
	readApiConfigProfiles,
	resolveApiConfigurationForTaskSelection,
	resolveTaskApiSelection,
} from "@/core/controller/models/apiProfiles"
import { createTaskApiModelShim, resolveActiveModelIdFromApiConfiguration } from "@/core/controller/models/taskApiModel"
import { buildStateTaskHistory } from "@/core/controller/state/stateTaskHistory"
import { parseMentions } from "@/core/mentions"
import { expandTaskNoteMentions } from "@/core/mentions/task-notes"
import { expandThreadMentions } from "@/core/mentions/thread-mentions"
import {
	ensureAgentSkillsDirectoryExists,
	ensureMcpServersDirectoryExists,
	ensureRulesDirectoryExists,
	ensureTaskDirectoryExists,
	ensureWorkflowsDirectoryExists,
} from "@/core/storage/disk"
import { clearSdkRemoteConfig, refreshSdkRemoteConfig } from "@/core/storage/remote-config/sdk-refresh"
import { StateManager } from "@/core/storage/StateManager"
import { WorkspaceRootManager } from "@/core/workspace/WorkspaceRootManager"
import { HostProvider } from "@/hosts/host-provider"
import { openPendingNoteEditor } from "@/hosts/vscode/NotebookPendingEditor"
import { VscodeTerminalManager } from "@/hosts/vscode/terminal/VscodeTerminalManager"
import { openFile as openFileIntegration } from "@/integrations/misc/open-file"
import { ExtensionRegistryInfo } from "@/registry"
import { OcaAuthService } from "@/services/auth/oca/OcaAuthService"
import { UrlContentFetcher } from "@/services/browser/UrlContentFetcher"
import { ClineError } from "@/services/error/ClineError"
import { McpHub } from "@/services/mcp/McpHub"
import { telemetryService } from "@/services/telemetry"
import { type CollectionInput, readEdits } from "@/services/walkthrough/collection"
import { recordToolEdits } from "@/services/walkthrough/recording"
import type { ClineExtensionContext } from "@/shared/cline"
import { ShowMessageRequest, ShowMessageType } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"
import { isClineManagedProvider } from "@/shared/utils/cline"
import { getCurrentBranch } from "@/utils/git-worktree"
import { arePathsEqual, getDesktopDir } from "@/utils/path"
import { resolveConfiguredTerminalEnv } from "@/utils/terminal-env"
import { getTerminalEnvWorkspaceRoot } from "@/utils/terminal-env-root"
import { ClineAccountService } from "./account-service"
import { AuthService, LogoutReason } from "./auth-service"
import { BUILTIN_SLASH_COMMANDS } from "./builtin-slash-commands"
import { buildStartSessionInput, createHistoryItemFromSession, getSessionApiSnapshot } from "./cline-session-factory"
import { buildAgentHooks } from "./hooks-adapter"
import { findMessageLinkTarget, resolveLinkedMessageText } from "./message-link-anchor"
import { MessageTranslatorState, reshapeErrorForWebview, translateSessionEvent } from "./message-translator"
import { createProviderCatalog } from "./model-catalog/catalog"
import type { Disposable, ProviderCatalog, ProviderConfigChange, ProviderConfigStore } from "./model-catalog/contracts"
import { parseProviderId } from "./model-catalog/provider-id"
import { createProviderConfigStore } from "./model-catalog/store"
import {
	PROVIDER_FAILURE_ERROR_TYPE,
	PROVIDER_FAILURE_PHASE,
	type ProviderFailureTelemetry,
	ProviderFailureTelemetryTurnGate,
} from "./provider-failure-telemetry"
import { RemoteConfigRefreshCoordinator } from "./remote-config-refresh-coordinator"
import { ScriptsHost } from "./scripts/script-host"
import { buildAsideConversation } from "./sdk-aside-conversation"
import {
	findVisibleCheckpointUserMessageByRun,
	getCheckpointRunCountForMessage,
	isVisibleCheckpointUserMessage,
} from "./sdk-checkpoints"
import { SdkCompactionCoordinator } from "./sdk-compaction-coordinator"
import { SdkDiffEditCoordinator } from "./sdk-diff-edit-coordinator"
import { SdkFollowupCoordinator } from "./sdk-followup-coordinator"
import { SdkForegroundCommandCoordinator } from "./sdk-foreground-command-coordinator"
import { SdkInteractionCoordinator } from "./sdk-interaction-coordinator"
import { SdkMcpCoordinator } from "./sdk-mcp-coordinator"
import { SdkMessageCoordinator, type SessionEventListener } from "./sdk-message-coordinator"
import { ACT_MODE_CONTINUATION_PROMPT, SdkModeCoordinator } from "./sdk-mode-coordinator"
import { SdkProviderChangeCoordinator } from "./sdk-provider-change-coordinator"
import { restoredThreadStatus } from "./sdk-restored-status"
import { SdkSessionConfigBuilder } from "./sdk-session-config-builder"
import { SdkSessionConfigChangeCoordinator } from "./sdk-session-config-change-coordinator"
import { SdkSessionEventCoordinator } from "./sdk-session-event-coordinator"
import { SdkSessionHistoryLoader } from "./sdk-session-history-loader"
import { SdkSessionLifecycle } from "./sdk-session-lifecycle"
import { SdkSessionRebuildScheduler } from "./sdk-session-rebuild-scheduler"
import { SdkTaskControlCoordinator } from "./sdk-task-control-coordinator"
import {
	SdkTaskHistory,
	sessionHistoryRecordToHistoryItem,
	sessionRecordActivityTs,
	sessionRecordStartedTs,
} from "./sdk-task-history"
import { SdkTaskStartCoordinator } from "./sdk-task-start-coordinator"
import { createVscodeSdkTelemetryHandle, type VscodeSdkTelemetryHandle } from "./sdk-telemetry"
import { isToolAutoApproved } from "./sdk-tool-policies"
import {
	extractSdkUserText,
	findSdkUserMessageIndexByOrdinal,
	getSdkCheckpointRunCountForMessageIndex,
	isSyntheticSdkUserMessage,
	type SdkUserMessage,
} from "./sdk-user-message-mapping"
import { readCurrentMessages } from "./session-host"
import { buildDisabledWorkflowNames, expandSlashCommands } from "./slash-command-expansion"
import { StatePostDebouncer } from "./state-post-debouncer"
import { CurrentBranchWatcher } from "./task-groups/current-branch-watcher"
import {
	asideDescendantIds,
	asideRootId,
	effectiveTaskGroupId,
	resolveEffectiveTaskGroupId,
	withEffectiveTaskGroups,
} from "./task-groups/effective-task-group"
import { HistorySearcher } from "./task-groups/history-search"
import { latestNotebookChangesMessage, notebookChangesMessage, restoreNotebookChanges } from "./task-groups/notebook-changes"
import { resolveNotebookOwner, type TaskNotebookContext } from "./task-groups/notebook-context"
import { createNotebookConversion, type NotebookConversionKind, notebookConversion } from "./task-groups/notebook-convert"
import { notebookDiff } from "./task-groups/notebook-diff"
import { NotebookStore, slugifyNoteName } from "./task-groups/notebook-store"
import { TaskGroupStore, taskGroupsRootDir } from "./task-groups/task-group-store"
import type { ThreadTranscriptToolsContext } from "./task-groups/thread-transcript-tool"
import { createTaskProxy, type TaskProxy } from "./task-proxy"
import { syncTelemetrySettingFromSharedGlobalSettings } from "./telemetry-settings-sync"
import { maybeGenerateThreadTitle, type ThreadTitleSource } from "./thread-title"
import { TurnActivityWatchdog } from "./turn-activity-watchdog"
import { TurnStateTracker } from "./turn-state-tracker"
import { createWorkspaceFileReadExecutor } from "./vscode-file-read-executor"
import { VscodeSessionHost } from "./vscode-session-host"
import type { VscodeTerminalExecutionMode } from "./vscode-terminal-execution-mode"
import { WebviewGrpcBridge } from "./webview-grpc-bridge"
import { resolveWorkspaceManagerPaths, resolveWorkspaceRootPath } from "./workspace-root"
import { ThreadWorktreeManager } from "./worktrees/thread-worktree-manager"

/**
 * Log a stub warning and return undefined.
 */
function stubWarn(name: string): void {
	Logger.warn(`[SdkController] STUB: ${name} not yet implemented`)
}

function metadataNumber(metadata: SessionHistoryRecord["metadata"] | undefined, key: string): number | undefined {
	const value = metadata?.[key]
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function usesClineAccountAuth(providerId: string): boolean {
	return getProviderAuthStorageId(providerId) === "cline"
}

function metadataBoolean(metadata: SessionHistoryRecord["metadata"] | undefined, key: string): boolean | undefined {
	const value = metadata?.[key]
	return typeof value === "boolean" ? value : undefined
}

function metadataString(metadata: SessionHistoryRecord["metadata"] | undefined, key: string): string | undefined {
	const value = metadata?.[key]
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function dateStringToTimestamp(value: string | null | undefined): number {
	if (!value) {
		return 0
	}
	const timestamp = Date.parse(value)
	return Number.isFinite(timestamp) ? timestamp : 0
}

function historyItemToTaskResponse(item: HistoryItem): TaskResponse {
	return TaskResponse.create({
		id: item.id,
		task: formatDisplayUserInput(item.task),
		ts: item.ts,
		isFavorited: item.isFavorited ?? false,
		isSettled: item.isSettled,
		settledAt: item.settledAt,
		parentTaskId: item.parentTaskId,
		forkedAtTs: item.forkedAtTs,
		size: item.size ?? 0,
		totalCost: item.totalCost ?? 0,
		tokensIn: item.tokensIn ?? 0,
		tokensOut: item.tokensOut ?? 0,
		cacheWrites: item.cacheWrites ?? 0,
		cacheReads: item.cacheReads ?? 0,
		isLegacy: item.isLegacy ?? false,
	})
}

interface TaskSessionContext {
	task: TaskProxy
	translator: MessageTranslatorState
	turn: TurnStateTracker
	messages: SdkMessageCoordinator
	interactions: SdkInteractionCoordinator
	events: SdkSessionEventCoordinator
	watchdog: TurnActivityWatchdog
	mode: "plan" | "act"
	cancelled: boolean
	/**
	 * The task group a new thread was started in. Core persists the session
	 * record (with its `taskGroupId` metadata) only when the first send lands,
	 * so until then the synthesized history row reads the group from here.
	 */
	taskGroupId?: string
	/**
	 * The saved-configuration selection this task was last using (per mode).
	 * Sessions pin to it so switching chats never rewrites a running chat's
	 * provider/model without changing the settings defaults.
	 */
	apiSelection?: TaskApiSelection
	/** Requested changes waiting for an idle session rebuild. */
	pendingApiSelection?: TaskApiSelection
	nextMessageSelection?: {
		previous: TaskApiSelection
		started: boolean
		restoring?: boolean
		deferred: { prompt: string; images?: string[]; files?: string[] }[]
	}
}

/**
 * The prompt a "Sign in to Cline" error offers to retry, and the task that
 * shows the error.
 */
interface ClineAuthRetry {
	task: TaskProxy
	prompt: string
	/** What the user explicitly picked or ran in the composer for `prompt`. */
	provenance?: ComposerProvenance
	/**
	 * The error was shown on a task that already had a conversation, such as
	 * a failed edit or checkpoint restore, rather than on a new task that
	 * failed before its session was created.
	 */
	hasConversation: boolean
}

/**
 * Edits and checkpoint restores start a new session for the same thread; carry
 * over what the user set on it (name, task, tags) so the replacement keeps them.
 */
function threadIdentityMetadata(item: HistoryItem | undefined): Record<string, unknown> {
	return {
		...(item?.title ? { threadTitle: item.title } : {}),
		...(item?.taskGroupId ? { taskGroupId: item.taskGroupId } : {}),
		...(item?.tags?.length ? { tags: item.tags } : {}),
		...(item?.dismissedAutoTags?.length ? { dismissedAutoTags: item.dismissedAutoTags } : {}),
	}
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class Controller {
	// SDK session state and the coordinators that drive it.
	private messageTranslatorState: MessageTranslatorState
	private turnStateTracker!: TurnStateTracker
	private messages: SdkMessageCoordinator
	private sessions: SdkSessionLifecycle
	private sessionRebuilds: SdkSessionRebuildScheduler
	private interactions: SdkInteractionCoordinator
	private diffEdits: SdkDiffEditCoordinator
	private sessionConfigBuilder: SdkSessionConfigBuilder
	private taskHistory: SdkTaskHistory
	private mode: SdkModeCoordinator
	private mcpTools: SdkMcpCoordinator
	private sessionConfigChanges: SdkSessionConfigChangeCoordinator
	private providerChanges: SdkProviderChangeCoordinator
	private followups: SdkFollowupCoordinator
	private taskControl: SdkTaskControlCoordinator
	private taskStart: SdkTaskStartCoordinator
	private compaction: SdkCompactionCoordinator
	private sessionEvents: SdkSessionEventCoordinator
	private sessionHistory: SdkSessionHistoryLoader
	private readonly sdkTelemetry: VscodeSdkTelemetryHandle
	private readonly providerFailureTelemetryTurnGate = new ProviderFailureTelemetryTurnGate()
	private readonly providerConfigStore: ProviderConfigStore
	private readonly providerCatalog: ProviderCatalog
	private readonly providerConfigStoreSubscription: Disposable
	private providerConfigStatePostScheduled = false
	// Debounces/coalesces postStateToWebview() calls — see StatePostDebouncer.
	private static readonly STATE_POST_DEBOUNCE_MS = 50
	private readonly statePostDebouncer: StatePostDebouncer

	// Bridges SDK events to the webview's gRPC streams.
	private grpcBridge: WebviewGrpcBridge

	// Presents the Task interface that gRPC handlers expect, delegating to the
	// active SDK session.
	private focusedTask?: TaskProxy
	private readonly taskSessions = new Map<string, TaskSessionContext>()
	private sessionEventStream!: SdkMessageCoordinator
	private readonly subagentThreads = new Map<string, HistoryItem>()
	private homeContext!: Pick<TaskSessionContext, "translator" | "turn" | "messages" | "interactions">

	get task(): TaskProxy | undefined {
		return this.focusedTask
	}
	set task(task: TaskProxy | undefined) {
		const previous = this.focusedTask
		if (
			previous &&
			previous.taskId !== task?.taskId &&
			!this.sessions.getSession(previous.taskId) &&
			!this.subagentThreads?.has(previous.taskId) &&
			this.taskSessions.get(previous.taskId)?.turn.currentPhase !== "streaming"
		) {
			this.taskSessions.get(previous.taskId)?.messages.dispose()
			this.taskSessions.delete(previous.taskId)
		}
		this.focusedTask = task
		const context = task ? this.getTaskSessionContext(task.taskId, task) : this.homeContext
		if (!context) return
		this.messageTranslatorState = context.translator
		this.turnStateTracker = context.turn
		this.messages = context.messages
		this.interactions = context.interactions
		this.sessions.focusSession(task?.taskId)
		this.messageTranslatorState.getMinter().bumpEpoch()
		this.turnStateTracker.set(this.turnStateTracker.currentPhase)
	}

	mcpHub: McpHub
	accountService: ClineAccountService
	authService: AuthService
	ocaAuthService: OcaAuthService
	readonly stateManager: StateManager

	// Lazy terminal manager for foreground (VS Code terminal) command execution.
	// Created on first use; shared across all sessions in this Controller's lifetime.
	// Only used in the `vscodeTerminal` execution mode — `backgroundExec` and the
	// standalone (JetBrains/CLI) host use the custom tool's SDK shell executor.
	private _terminalManager?: VscodeTerminalManager

	// Registry of in-flight foreground (VS Code terminal) command executions.
	// Owned here — not by the session — so it survives session rebuilds, which
	// recreate the tool set. Drives the "Proceed While Running" button.
	private readonly foregroundCommands = new SdkForegroundCommandCoordinator({
		onRunningChanged: () => {
			void this.postStateToWebview()
		},
	})

	// Private state kept for stub compatibility
	private backgroundCommandRunning = false
	private backgroundCommandTaskId?: string
	private pendingClineAuthRetry?: ClineAuthRetry
	checkpointRestoreInput?: ExtensionState["checkpointRestoreInput"]

	// Timer for periodic remote config fetching (enterprise policy enforcement)
	private remoteConfigTimer?: NodeJS.Timeout
	private remoteConfigCoreIntegration?: PreparedRemoteConfigCoreIntegration
	private remoteConfigRevision = 0
	private remoteConfigAvailable = false
	private readonly remoteConfigRefreshCoordinator = new RemoteConfigRefreshCoordinator<boolean>((isCurrent) =>
		this.performRemoteConfigRefresh(isCurrent),
	)
	private resolveInitialRemoteConfigReady!: () => void
	private readonly initialRemoteConfigReady = new Promise<void>((resolve) => {
		this.resolveInitialRemoteConfigReady = resolve
	})

	// Watches user-instruction files (workflows/skills/rules), including those
	// materialized by remote config under `.cline/remote-config/`. Used to expand
	// `/workflow` and `/skill` slash commands into their instruction bodies before
	// the prompt reaches the model — the same mechanism the CLI uses in
	// `buildUserInputMessage`. The agent loop never auto-expands commands, so this
	// host-side expansion is required. Created lazily (memoized as a promise to be
	// race-free under concurrent first sends) and rebuilt if the workspace root
	// changes.
	private userInstructionService?: Promise<UserInstructionConfigService>
	private userInstructionServiceRoot?: string
	private isDisposed = false

	// Task-group ("Tasks") storage under ~/.cline/data/task-groups — deliberately
	// outside data/sessions and data/tasks, which the SDK owns and other Cline
	// installs share. The watcher refreshes webview state when notes/groups
	// change on disk (hand edits, or another install writing to ~/.cline).
	private readonly taskGroupStore = new TaskGroupStore()
	/** Saved scripts: the `script` tool, per-script approvals and `/script` composer runs. */
	readonly scripts = new ScriptsHost({
		getToggles: () => ({
			global: StateManager.get().getGlobalSettingsKey("globalScriptToggles") ?? {},
			workspace: StateManager.get().getWorkspaceStateKey("scriptToggles") ?? {},
		}),
		getWorkspaceRoot: () => this.lastKnownWorkspaceRoot,
		getLogDir: () => path.join(HostProvider.get().globalStorageFsPath, "script-logs"),
		getTrustFile: () => path.join(HostProvider.get().globalStorageFsPath, "script-trust.json"),
		// The same environment every other command Cline runs gets (settings + .env + PATH).
		// Same .env base as commands and the settings preview (the workspace root, not the script's cwd).
		resolveEnv: async (cwd) =>
			(
				await resolveConfiguredTerminalEnv(StateManager.get(), {
					cwd,
					workspaceRoot: await getTerminalEnvWorkspaceRoot(cwd),
				})
			).env,
	})
	private readonly notebookStore = new NotebookStore()
	private readonly notebookEditors: { dispose(): void }[] = []
	private readonly historySearcher = new HistorySearcher()
	// Bumped per search kind on every searchHistory call so an in-flight scan for
	// a superseded request can notice and return early. Keyed by kind because the
	// search view runs its notes and messages searches in parallel.
	private readonly historySearchGenerations = new Map<string, number>()
	private taskGroupsWatcher?: FSWatcher
	private taskGroupsSummaryCache?: { summaries: TaskGroupSummary[]; at: number }
	// User-mentioned `thread:` ids per conversation (owner thread id), kept in
	// memory for immediate access and mirrored into the thread's session
	// metadata so the transcript-tool allow-list survives session rebuilds.
	private readonly referencedThreads = new Map<string, Set<string>>()
	private readonly currentBranchWatcher = new CurrentBranchWatcher(() => {
		void this.refreshCurrentBranch().catch(() => {})
	})
	private branchRefresh?: Promise<void>
	private branchRefreshRequested = false
	private currentBranchCache?: { cwd: string; branch: string; at: number }

	// Synchronous snapshot of getWorkspaceRoot()'s latest result, for the message
	// translator (which runs synchronously and relativizes the tool paths shown in
	// the chat view). Warmed in the constructor and refreshed on every call.
	private lastKnownWorkspaceRoot?: string

	get remoteConfig(): RemoteConfig | undefined {
		return this.remoteConfigCoreIntegration?.prepared.bundle?.remoteConfig
	}

	get remoteConfigBundle(): RemoteConfigBundle | undefined {
		return this.remoteConfigCoreIntegration?.prepared.bundle
	}

	get isRemoteConfigAvailable(): boolean {
		return this.remoteConfigAvailable
	}

	get currentRemoteConfigRevision(): number {
		return this.remoteConfigRevision
	}

	private readonly workspaceNotices = new Map<string, string>()
	private readonly seenWorktreeRemovals = new Map<string, number>()
	private async resolveSessionWorkspace(id: string): Promise<string | undefined> {
		const mapping = await this.threadWorktrees.get(id)
		if (mapping) return mapping.cwd
		const removed = await this.threadWorktrees.removedWorkspace(id)
		if (!removed) return undefined
		if (this.seenWorktreeRemovals.get(id) !== removed.removedAt) {
			this.workspaceNotices.set(
				id,
				`The thread worktree was removed. Continue in the user's workspace at ${removed.workspace}.`,
			)
			this.seenWorktreeRemovals.set(id, removed.removedAt)
		}
		return removed.workspace
	}
	readonly threadWorktrees: ThreadWorktreeManager

	constructor(readonly context: ClineExtensionContext) {
		this.threadWorktrees = new ThreadWorktreeManager(path.join(context.globalStorageUri.fsPath, "thread-worktrees"))
		const controller = this
		// StateManager must be initialized before creating the Controller
		this.stateManager = StateManager.get()
		syncTelemetrySettingFromSharedGlobalSettings(this.stateManager)
		this.sdkTelemetry = createVscodeSdkTelemetryHandle()
		this.statePostDebouncer = new StatePostDebouncer({
			debounceMs: Controller.STATE_POST_DEBOUNCE_MS,
			flush: () => this.flushStateToWebview(),
		})
		this.providerConfigStore = createProviderConfigStore()
		this.providerCatalog = createProviderCatalog(this.providerConfigStore)
		this.providerConfigStoreSubscription = this.providerConfigStore.subscribe((event) => {
			this.handleProviderConfigChange(event)
		})

		// IMPORTANT: Use ~/.cline/data/settings/ for the settings directory,
		// NOT ensureSettingsDirectoryExists() which returns the VSCode extension
		// storage path (HostProvider.globalStorageFsPath/settings/). The MCP
		// settings file lives at ~/.cline/data/settings/cline_mcp_settings.json
		// (shared across VSCode, CLI, and JetBrains clients).
		this.mcpHub = new McpHub(
			() => ensureMcpServersDirectoryExists(),
			async () => {
				const settingsDir = path.dirname(resolveDefaultMcpSettingsPath())
				await fs.mkdir(settingsDir, { recursive: true })
				return settingsDir
			},
			ExtensionRegistryInfo.version,
			telemetryService,
		)

		// Initialize SDK-backed auth and account services.
		this.authService = AuthService.getInstance(this, this.sdkTelemetry.telemetry)
		this.ocaAuthService = OcaAuthService.initialize(this)
		this.accountService = ClineAccountService.getInstance()

		// Initialize message translator state. The mode getter styles the inferred turn-final
		// completion row (plan → yellow plan box, act → green completion box).
		this.messageTranslatorState = new MessageTranslatorState(
			undefined,
			// Provider backing the active turn — error reshaping branches on it
			// (BYOK credential guidance vs the cline sign-in card). Prefer the
			// active session's start metadata over the current settings
			// selection: a provider/mode switch made while a turn is in flight
			// changes the settings selection immediately, but the failing turn
			// still belongs to the session's provider. Provider switches always
			// start a new session, so start metadata never goes stale the way
			// a mid-task model-only switch does for models below.
			() => this.getSessionProviderId() ?? this.getActiveProviderId(),
			() => (this.stateManager.getGlobalSettingsKey("mode") === "plan" ? "plan" : "act"),
			() => this.lastKnownWorkspaceRoot,
			// Model backing the active turn — lets error reshaping recognize
			// retired cline-free/ models (the error payload itself never names one).
			// The task shim is preferred over session-start metadata: a mid-task
			// model-only switch updates the running session's model in place
			// (updateActiveSessionModel) and refreshes the shim, but never touches
			// startConfig/manifest, which would otherwise report the stale model.
			// The shim starts as "unknown" (filtered out by getTaskModelId), so
			// fresh sessions still resolve through their start metadata.
			() => this.getTaskModelId() ?? this.getSessionModelId(),
		)
		// Warm the synchronous workspace-root snapshot used for display-path
		// relativization (getWorkspaceRoot never rejects — it falls back internally).
		void this.getWorkspaceRoot()
		// Authoritative UI-mode tracker, sharing the one id/seq/epoch authority.
		this.turnStateTracker = new TurnStateTracker(this.messageTranslatorState.getMinter())
		this.messages = new SdkMessageCoordinator({
			getTask: () => this.task,
			// Stamp seq/epoch on every message flowing to the webview from the shared authority.
			getMinter: () => this.messageTranslatorState.getMinter(),
		})
		this.sessionHistory = new SdkSessionHistoryLoader()
		this.sessionConfigBuilder = new SdkSessionConfigBuilder({
			stateManager: this.stateManager,
			emitHookMessage: (msg) => this.messages.emitHookMessage(msg),
			onConsecutiveMistakeLimitReached: (context) => this.interactions.handleConsecutiveMistakeLimitReached(context),
		})
		this.diffEdits = new SdkDiffEditCoordinator({
			getCwd: async (sessionId) =>
				this.sessions?.getSession(sessionId ?? "")?.startConfig?.cwd || (await this.getWorkspaceRoot()),
			isBackgroundEditEnabled: () => !!this.stateManager.getGlobalSettingsKey("backgroundEditEnabled"),
		})
		this.interactions = new SdkInteractionCoordinator({
			get messages() {
				return controller.messages
			},
			getSessionId: () => this.sessions.getActiveSession()?.sessionId ?? "",
			postStateToWebview: () => this.postStateToWebview(),
			// Share the single id/seq/epoch authority so interaction-minted ids (tool-approval
			// asks, ask_question, user_feedback) never collide with translator-minted ids.
			getMinter: () => this.messageTranslatorState.getMinter(),
			setTurnPhase: (phase, anchorTs) => this.turnStateTracker.set(phase, anchorTs),
			// Open the diff editor preview before the approval buttons render.
			onToolApprovalAsk: (request) =>
				this.diffEdits.openForApproval(request.toolCallId, request.toolName, request.input, request.sessionId),
			recordApprovedToolMessage: (toolCallId, messageTs) =>
				this.messageTranslatorState.recordApprovedToolMessageTs(toolCallId, messageTs),
			recordDeniedToolApproval: (toolCallId, toolName, reason) => {
				this.messageTranslatorState.recordDeniedToolApproval(toolCallId, toolName, reason)
				// A denied edit's executor never runs, so close its diff preview here. Covers
				// manual Reject and clearPending (task cancel/abort) in one place.
				void this.diffEdits.discardPreview(toolCallId)
			},
			shouldAutoApproveTool: (request) => {
				const autoApprovalSettings = this.stateManager.getGlobalSettingsKey("autoApprovalSettings")
				return autoApprovalSettings ? isToolAutoApproved(request.toolName, autoApprovalSettings) : false
			},
			getCwd: (sessionId) => this.sessions.getSession(sessionId ?? "")?.startConfig?.cwd ?? this.lastKnownWorkspaceRoot,
		})
		this.sessions = new SdkSessionLifecycle({
			onStatusChange: (id, status) => {
				if (this.isDisposed) return
				void this.taskHistory
					.saveThreadStatus(id, status)
					.catch((error) => Logger.warn("[SdkController] Failed to persist thread status", error))
			},
			acquireSessionLease: (id) => this.threadWorktrees.acquireSessionLease(id),
			resolveSessionWorkspace: (id) => this.resolveSessionWorkspace(id),
			consumeWorkspaceNotice: (id) => {
				const notice = this.workspaceNotices.get(id)
				this.workspaceNotices.delete(id)
				return notice
			},
			prepareStartInput: async (input) => {
				const id = input.config?.sessionId || createSessionId()
				const mapping = await this.threadWorktrees.get(id)
				if (mapping) {
					await this.threadWorktrees.assertPresent(mapping)
					input = { ...input, config: { ...input.config, cwd: mapping.cwd, workspaceRoot: mapping.cwd } }
				} else {
					const workspace = await this.resolveSessionWorkspace(id)
					if (workspace) input = { ...input, config: { ...input.config, cwd: workspace, workspaceRoot: workspace } }
				}
				const previous = this.taskSessions.get(id)?.nextMessageSelection?.previous
				return {
					...input,
					...(previous ? { sessionMetadata: { ...input.sessionMetadata, apiSelection: previous } } : {}),
					config: {
						...input.config,
						sessionId: id,
						onConsecutiveMistakeLimitReached: (context) =>
							this.getTaskSessionContext(id).interactions.handleConsecutiveMistakeLimitReached(context),
						hooks: buildAgentHooks(
							this.stateManager,
							(message) => this.getTaskSessionContext(id).messages.emitHookMessage(message),
							input.config?.cwd,
							{ taskResumed: input.sessionMetadata?.taskResumed === true },
						),
					},
				}
			},
			mcpHub: this.mcpHub,
			telemetry: this.sdkTelemetry.telemetry,
			resolveNotebook: (input) => this.resolveTaskNotebook(input.config.sessionId, input.sessionMetadata),
			resolveThreadTranscript: (input) => this.resolveThreadTranscriptContext(input),
			resolveScripts: (input) => this.scripts.toolContext(input.config.cwd),
			requestToolApproval: async (request) =>
				this.getTaskSessionContext(
					this.sessions.getSession(request.sessionId)
						? request.sessionId
						: await this.resolveTaskSessionId(request.conversationId),
				).interactions.handleRequestToolApproval(request),
			askQuestion: async (question, options, context) =>
				this.getTaskSessionContext(
					Array.from(this.subagentThreads?.values() ?? []).find((child) => child.agentId === context.agentId)
						?.runtimeOwnerTaskId ??
						context.sessionId ??
						(await this.resolveTaskSessionId(context.conversationId ?? "")),
				).interactions.handleAskQuestion(question, options, context),
			editorExecutor: (input, cwd, context) =>
				recordToolEdits(
					async () =>
						ensureTaskDirectoryExists(
							context.sessionId ?? (await this.resolveTaskSessionId(context.conversationId ?? "")),
						),
					input,
					cwd,
					context,
					() => this.diffEdits.executeEditorTool(input, cwd, context),
					(error) => Logger.warn(`[Walkthrough] Edit recording failed: ${error}`),
				),
			applyPatchExecutor: (input, cwd, context) =>
				recordToolEdits(
					async () =>
						ensureTaskDirectoryExists(
							context.sessionId ?? (await this.resolveTaskSessionId(context.conversationId ?? "")),
						),
					input,
					cwd,
					context,
					() => this.diffEdits.executeApplyPatchTool(input, cwd, context),
					(error) => Logger.warn(`[Walkthrough] Edit recording failed: ${error}`),
				),
			// The SDK's built-in reader resolves relative paths against the extension
			// host's process.cwd() (usually "/"); resolve them against the workspace instead.
			readFileExecutor: createWorkspaceFileReadExecutor(
				async (context) =>
					this.sessions.getSession(context.sessionId ?? "")?.startConfig?.cwd || (await this.getWorkspaceRoot()),
			),
			onSessionEvent: (event) => {
				if (this.handleSubagentEvent(event)) return
				if (!this.sessions.getSession(event.payload.sessionId) && !this.taskSessions.has(event.payload.sessionId)) return
				this.getTaskSessionContext(event.payload.sessionId)
					.events.handleSessionEvent(event)
					.catch((err) => {
						Logger.error("[SdkController] Failed to handle session event:", err)
					})
			},
			onDidBecomeIdle: () => this.handleSessionBecameIdle(),
			onSessionReplaced: (id) => this.handleParentSessionReplaced(id),
			beforeStartSession: () => this.ensureRemoteConfigForSessionStart(),
			getRemoteConfigIntegration: () => this.remoteConfigCoreIntegration,
			foregroundCommands: this.foregroundCommands,
			getTerminalManager: () => {
				// Guarded by getEffectiveTerminalExecutionMode() at the read sites
				// (vscode-session-host.ts, sdk-session-config-change-coordinator.ts):
				// this factory itself is only invoked when a caller has already
				// resolved to "vscodeTerminal" mode on a real VS Code host, but
				// VscodeTerminalManager's constructor still assumes
				// vscode.window.onDidStartTerminalShellExecution exists, which the
				// standalone (JetBrains/CLI) stub does not provide.
				if (!this._terminalManager) {
					this._terminalManager = new VscodeTerminalManager()
					this.applyTerminalSettings(this._terminalManager)
					Logger.log("[SdkController] Created VscodeTerminalManager for foreground terminal execution")
				}
				return this._terminalManager
			},
			onSessionRemoved: (id) => {
				this.mcpTools?.forgetSession(id)
				this.sessionRebuilds?.forgetSession(id)
				this.taskSessions.get(id)?.interactions.clearPending("Session removed")
				this.taskSessions.get(id)?.watchdog.stop()
				this.taskSessions.get(id)?.messages.dispose()
				this.taskSessions.delete(id)
			},
			deferSend: (id, prompt, images, files, delivery) => this.deferOneTurnFollowup(id, prompt, images, files, delivery),
			onSendStart: (id, delivery) => {
				const temporary = this.taskSessions.get(id)?.nextMessageSelection
				if (temporary && !temporary.started) temporary.started = true
				if (delivery !== "interject") this.getTaskSessionContext(id).cancelled = false
				this.getTaskSessionContext(id).turn.set("streaming")
				this.getTaskSessionContext(id).watchdog.activity()
				void this.taskHistory.markTaskActive(id)
				this.beginProviderFailureTelemetryTurn()
			},
			// this.mode is assigned later in this constructor; the closure only
			// runs at send time, long after construction completes.
			consumeModeSwitchNotice: (sessionId) => this.mode.consumeModeSwitchNotice(sessionId),
			consumeMcpChangeNotice: (id) => this.mcpTools.consumeMcpChangeNotice(id),
			onSendComplete: async (id) => {
				await this.taskHistory.markTaskActive(id)
				// Normal flows close their diff sessions inline; anything left here is orphaned.
				if (this.task?.taskId === id) void this.diffEdits.discardAllPreviews("turn complete")

				this.postStateToWebview().catch((err) => {
					Logger.error("[SdkController] Failed to post state after turn:", err)
				})
			},
			onHeldSendCancelled: (sessionId, prompt, images, files) => {
				const context = this.getTaskSessionContext(sessionId)
				context.messages.appendMessages([
					{
						ts: context.translator.nextTs(),
						type: "say",
						say: "text",
						text: `Cancelled before sending:\n\n${prompt}`,
						images,
						files,
					},
				])
				void this.postStateToWebview().catch((error) => Logger.error("Failed to post cancelled submission:", error))
			},
			onSendError: async (error, sessionId) => {
				const context = this.getTaskSessionContext(sessionId)
				context.turn.set("error")
				context.watchdog.stop()
				if (this.task?.taskId !== sessionId) {
					context.messages.appendMessages([
						{ ts: context.translator.nextTs(), type: "say", say: "error", text: String(error) },
					])
					await this.postStateToWebview()
					return
				}
				// A turn failed — the UI shows error recovery (Retry / Sign In / Add Credits).
				void this.diffEdits.discardAllPreviews("turn error")
				this.turnStateTracker.set("error")
				const errorMessage = error instanceof Error ? error.message : String(error)
				const providerId = this.getSessionProviderId(sessionId) ?? this.getActiveProviderId()
				const isClineAuthError =
					isClineManagedProvider(providerId) &&
					(errorMessage.includes(CLINE_ACCOUNT_AUTH_ERROR_MESSAGE) ||
						errorMessage.toLowerCase().includes("missing api key") ||
						errorMessage.toLowerCase().includes("unauthorized"))

				if (isClineAuthError) {
					this.captureProviderFailure({
						sessionId,
						error,
						providerId,
						errorType: PROVIDER_FAILURE_ERROR_TYPE.AUTH,
						failurePhase: PROVIDER_FAILURE_PHASE.PREFLIGHT,
					})
					this.emitClineAuthError()
				} else if (isClineManagedProvider(providerId) && this.isClineBalanceError(errorMessage)) {
					this.captureProviderFailure({
						sessionId,
						error,
						providerId,
						errorType: PROVIDER_FAILURE_ERROR_TYPE.BALANCE,
						failurePhase: PROVIDER_FAILURE_PHASE.PREFLIGHT,
					})
					this.emitClineBalanceError(errorMessage)
				} else {
					this.captureProviderFailure({
						sessionId,
						error,
						providerId,
						errorType: PROVIDER_FAILURE_ERROR_TYPE.SEND_ERROR,
						failurePhase: PROVIDER_FAILURE_PHASE.STREAMING,
					})
					this.messages.emitSessionEvents(
						[
							{
								ts: Date.now(),
								type: "say",
								say: "error",
								text: `Agent error: ${errorMessage}`,
								partial: false,
							},
						],
						{ type: "status", payload: { sessionId, status: "error" } },
					)
				}
				this.postStateToWebview().catch(() => {})
			},
		})
		this.sessionRebuilds = new SdkSessionRebuildScheduler({ sessions: this.sessions })
		this.taskHistory = new SdkTaskHistory({
			resolveNotebookChanges: async (id, messages) =>
				restoreNotebookChanges(
					messages,
					id,
					await Promise.all(
						(await this.notebookStore.listPending(id)).map((review) => this.notebookStore.reviewDiffs(review, id)),
					),
					() => this.messageTranslatorState.nextTs(),
				),
			beforeDeleteSession: async (id) => {
				await this.sessionRebuilds.runExclusive(async () => {
					const context = this.taskSessions.get(id)
					if (context) {
						context.cancelled = true
						context.interactions.clearPending("Task deleted")
						context.messages.cancelPendingSave()
					}
					await this.sessions.removeSession(id)
				})
				if (
					this.task?.taskId === id ||
					(this.subagentThreads?.get(this.task?.taskId ?? "")?.runtimeOwnerTaskId ??
						this.subagentThreads?.get(this.task?.taskId ?? "")?.parentTaskId) === id
				)
					await this.clearTask()
				for (const [childId, child] of this.subagentThreads) {
					if ((child.runtimeOwnerTaskId ?? child.parentTaskId) !== id && childId !== id) continue
					this.taskSessions.get(childId)?.messages.dispose()
					this.taskSessions.delete(childId)
					this.subagentThreads.delete(childId)
					delete this.sessions.sessionStatuses[childId]
				}
			},
			mcpHub: this.mcpHub,
			sessions: this.sessions,
			legacyExtensionStorageDir: this.context.globalStorageUri.fsPath,
			telemetry: telemetryService,
			// History rendering mints ids from the shared authority so regenerated history ids
			// never overlap live-session ids.
			getMinter: () => this.messageTranslatorState.getMinter(),
		})
		void this.ensureTaskGroupsWatcher()
		this.mode = new SdkModeCoordinator({
			getTaskApiSelection: (id) =>
				this.taskSessions.get(id)?.pendingApiSelection ?? this.taskSessions.get(id)?.apiSelection,
			onModeRebuilt: async (id, mode, selection) => {
				this.getTaskSessionContext(id).mode = mode
				this.refreshTaskApiModel(id)
				if (selection) this.recordTaskApiSelection(id, selection)
				await this.taskHistory.setTaskMode(id, mode)
			},
			resumeInAct: async (content) => {
				const id = this.task?.taskId
				if (!id) return false
				this.turnStateTracker.set("streaming")
				this.messageTranslatorState.clearTurnOutcome()
				await this.followups.askResponse(
					content?.message,
					content?.images,
					content?.files,
					undefined,
					undefined,
					ACT_MODE_CONTINUATION_PROMPT,
					undefined,
					normalizeProvenance(content?.provenance),
				)
				return this.task?.taskId === id && this.sessions.getSession(id)?.isRunning === true
			},
			stateManager: this.stateManager,
			sessions: this.sessions,
			get interactions() {
				return controller.interactions
			},
			get messages() {
				return controller.messages
			},
			sessionConfigBuilder: this.sessionConfigBuilder,
			getTask: () => this.task,
			getWorkspaceRoot: () => this.getWorkspaceRoot(),
			loadInitialMessages: async (sdkHost, sessionId) =>
				(await this.sessionHistory.loadInitialMessages(sdkHost, sessionId)) ?? [],
			buildStartSessionInput,
			emitClineAuthError: () => this.emitClineAuthErrorWithTelemetry(),
			resetMessageTranslator: () => this.resetMessageTranslatorAndFence(),
			postStateToWebview: () => this.postStateToWebview(),
			getTurnPhase: () => this.turnStateTracker.currentPhase,
			setTurnPhase: (phase, anchorTs) => this.turnStateTracker.set(phase, anchorTs),
			resolveContextMentions: (text, provenance) => this.resolveContextMentions(text, undefined, provenance),
			rebuilds: this.sessionRebuilds,
			onAutoContinueStarting: () => {
				this.turnStateTracker.set("streaming")
				this.messageTranslatorState.clearTurnOutcome()
			},
			onAutoContinueFailed: () => {
				this.turnStateTracker.set("error")
			},
		})
		this.mcpTools = new SdkMcpCoordinator({
			getToolSnapshot: () =>
				Object.fromEntries(
					this.mcpHub
						.getServers()
						.filter((server) => server.status === "connected" && !server.disabled)
						.map((server) => [server.name, (server.tools ?? []).map((tool) => tool.name).sort()]),
				),
			getMessages: (id) => this.getTaskSessionContext(id).messages,
			stateManager: this.stateManager,
			sessions: this.sessions,
			get messages() {
				return controller.messages
			},
			sessionConfigBuilder: this.sessionConfigBuilder,
			getWorkspaceRoot: () => this.getWorkspaceRoot(),
			loadInitialMessages: async (sdkHost, sessionId) =>
				(await this.sessionHistory.loadInitialMessages(sdkHost, sessionId)) ?? [],
			buildStartSessionInput,
			postStateToWebview: () => this.postStateToWebview(),
			rebuilds: this.sessionRebuilds,
		})
		this.sessionConfigChanges = new SdkSessionConfigChangeCoordinator({
			getMessages: (id) => this.getTaskSessionContext(id).messages,
			stateManager: this.stateManager,
			sessions: this.sessions,
			get messages() {
				return controller.messages
			},
			sessionConfigBuilder: this.sessionConfigBuilder,
			getWorkspaceRoot: () => this.getWorkspaceRoot(),
			loadInitialMessages: async (sdkHost, sessionId) =>
				(await this.sessionHistory.loadInitialMessages(sdkHost, sessionId)) ?? [],
			buildStartSessionInput,
			postStateToWebview: () => this.postStateToWebview(),
			rebuilds: this.sessionRebuilds,
		})
		this.providerChanges = new SdkProviderChangeCoordinator({
			stateManager: this.stateManager,
			sessions: this.sessions,
			get messages() {
				return controller.messages
			},
			sessionConfigBuilder: this.sessionConfigBuilder,
			getTask: () => this.task,
			getWorkspaceRoot: () => this.getWorkspaceRoot(),
			loadInitialMessages: async (sdkHost, sessionId) =>
				(await this.sessionHistory.loadInitialMessages(sdkHost, sessionId)) ?? [],
			buildStartSessionInput,
			getTaskApiSelection: (taskId) => {
				const context = this.taskSessions.get(taskId)
				return context?.pendingApiSelection ?? context?.apiSelection
			},
			onSelectionRebuilt: (taskId, selection, requestedSelection) =>
				this.commitTaskApiSelection(taskId, selection, requestedSelection),
			postStateToWebview: () => this.postStateToWebview(),
			rebuilds: this.sessionRebuilds,
		})
		this.followups = new SdkFollowupCoordinator({
			getTaskApiSelection: (id) =>
				this.taskSessions.get(id)?.pendingApiSelection ?? this.taskSessions.get(id)?.apiSelection,
			stateManager: this.stateManager,
			get interactions() {
				return controller.interactions
			},
			sessions: this.sessions,
			get messages() {
				return controller.messages
			},
			taskHistory: this.taskHistory,
			sessionConfigBuilder: this.sessionConfigBuilder,
			runExclusive: (operation) => this.sessionRebuilds.runExclusive(operation),
			getTask: () => this.task,
			createTempSessionHost: () => this.createRemoteConfigAwareSessionHost(),
			getWorkspaceRoot: () => this.getWorkspaceRoot(),
			loadInitialMessages: (sessionHost, taskId) => this.sessionHistory.loadInitialMessages(sessionHost, taskId),
			buildStartSessionInput,
			resolveContextMentions: (text, provenance) => this.resolveContextMentions(text, undefined, provenance),
			isClineManagedProviderActive: () => this.isClineManagedProviderActive(),
			emitClineAuthError: () => this.emitClineAuthErrorWithTelemetry(),
			resetMessageTranslator: () => this.resetMessageTranslatorAndFence(),
			postStateToWebview: () => this.postStateToWebview(),
			onResumeFailed: () => {
				this.turnStateTracker.set("error")
			},
			onFollowUpAbandoned: () => {
				// Settle the streaming phase askResponse pre-set, unless a turn
				// (for example on the newly displayed task) has actually started.
				if (this.turnStateTracker.currentPhase === "streaming" && !this.sessions.getActiveSession()?.isRunning) {
					this.turnStateTracker.set("idle")
				}
			},
		})
		this.taskControl = new SdkTaskControlCoordinator({
			sessions: this.sessions,
			get interactions() {
				return controller.interactions
			},
			get messages() {
				return controller.messages
			},
			taskHistory: this.taskHistory,
			getTask: () => this.task,
			setTask: (task) => {
				this.task = task
			},
			onAskResponse: (text, images, files, decisionId, provenance) =>
				this.askResponse(text, images, files, decisionId, provenance),
			resetMessageTranslator: () => this.resetMessageTranslatorAndFence(),
			// Bump the epoch synchronously before abort so straggler events from the cancelled
			// turn carry the old epoch and are dropped by the webview. The resumable phase is set
			// in SdkController.cancelTask before this runs.
			setTaskMode: (mode) => this.stateManager.setGlobalState("mode", mode),
			focusLiveTask: (id, historyItem) => {
				if (historyItem?.isSubagent && !this.subagentThreads?.has(id)) this.subagentThreads.set(id, historyItem)
				const context = this.taskSessions.get(id)
				if (!context || (!this.sessions.getSession(id) && !this.subagentThreads?.has(id))) return false
				this.task = context.task
				this.stateManager.setGlobalState("mode", context.mode)
				if (historyItem) this.restoreTaskApiSelection(historyItem, context.mode)
				return true
			},
			getLiveTaskItem: (id) => this.subagentThreads?.get(id) ?? this.liveTaskHistoryItem(id),
			applyTaskApiSelection: (historyItem, mode) => this.restoreTaskApiSelection(historyItem, mode),
			raiseCancelFence: () => {
				if (this.task) this.getTaskSessionContext(this.task.taskId).cancelled = true
				this.messageTranslatorState.clearApprovedToolMessageTs()
				this.messageTranslatorState.getMinter().bumpEpoch()
			},
			setTurnPhase: (phase, anchorTs) => this.turnStateTracker.set(phase, anchorTs),
			postStateToWebview: () => this.postStateToWebview(),
			rebuilds: this.sessionRebuilds,
			clearTaskSettings: () => this.stateManager.clearTaskSettings(),
		})
		this.taskStart = new SdkTaskStartCoordinator({
			stateManager: this.stateManager,
			sessions: this.sessions,
			get messages() {
				return controller.messages
			},
			taskHistory: this.taskHistory,
			sessionConfigBuilder: this.sessionConfigBuilder,
			buildStartSessionInput,
			createHistoryItemFromSession,
			clearTask: async () => {
				this.pendingClineAuthRetry = undefined
				await this.taskControl.clearTask()
			},
			setTask: (task) => {
				this.task = task
			},
			createTaskContext: (id, task) => this.getTaskSessionContext(id, task),
			onAskResponse: (text, images, files, decisionId, provenance) =>
				this.askResponse(text, images, files, decisionId, provenance),
			onCancelTask: () => this.cancelTask(),
			getWorkspaceRoot: () => this.getWorkspaceRoot(),
			createTempSessionHost: () => this.createRemoteConfigAwareSessionHost(),
			loadInitialMessages: (reader, taskId) => this.sessionHistory.loadInitialMessages(reader, taskId),
			resolveContextMentions: (text, id, provenance) => this.resolveContextMentions(text, id, provenance),
			isClineManagedProviderActive: () => this.isClineManagedProviderActive(),
			emitClineAuthError: (task, provenance) => this.emitClineAuthErrorWithTelemetry(task, undefined, provenance),
			captureProviderApiError: (event) => this.captureProviderFailure(event),
			prepareWorkspace: async (id, title, workspace, runInWorktree) => {
				const enabled = runInWorktree === true
				if (!enabled) return workspace
				return (
					await this.threadWorktrees.create(
						id,
						title,
						workspace,
						!!this.stateManager.getWorkspaceStateKey("worktreeToggles")?.disabled,
					)
				).cwd
			},
			consumeDraftApiSelection: () => {
				const draft = this.draftApiSelection
				this.draftApiSelection = undefined
				return draft
			},
			recordTaskApiSelection: (taskId, selection, mode) => {
				this.getTaskSessionContext(taskId).mode = mode
				this.recordTaskApiSelection(taskId, selection)
			},
			recordTaskGroup: (taskId, taskGroupId) => {
				this.getTaskSessionContext(taskId).taskGroupId = taskGroupId
			},
			postStateToWebview: () => this.postStateToWebview(),
		})
		this.compaction = new SdkCompactionCoordinator({
			getTaskApiSelection: (id) =>
				this.taskSessions.get(id)?.pendingApiSelection ?? this.taskSessions.get(id)?.apiSelection,
			stateManager: this.stateManager,
			sessions: this.sessions,
			rebuilds: this.sessionRebuilds,
			get messages() {
				return controller.messages
			},
			taskHistory: this.taskHistory,
			sessionConfigBuilder: this.sessionConfigBuilder,
			getDisplayedTaskId: () => this.task?.taskId,
			createTempSessionHost: () => this.createRemoteConfigAwareSessionHost(),
			loadInitialMessages: (reader, taskId) => this.sessionHistory.loadInitialMessages(reader, taskId),
			getWorkspaceRoot: () => this.getWorkspaceRoot(),
			postStateToWebview: () => this.postStateToWebview(),
		})
		this.sessionEvents = new SdkSessionEventCoordinator({
			messageTranslatorState: this.messageTranslatorState,
			sessions: this.sessions,
			get messages() {
				return controller.messages
			},
			taskHistory: this.taskHistory,
			stateManager: this.stateManager,
			getTask: () => this.task,
			postStateToWebview: () => this.postStateToWebview(),
			setTurnPhase: (phase, anchorTs) => this.turnStateTracker.set(phase, anchorTs),
			getTurnPhase: () => this.turnStateTracker.currentPhase,
			captureProviderApiError: (event) => this.captureProviderFailure(event),
			beginProviderFailureTelemetryTurn: () => this.beginProviderFailureTelemetryTurn(),
		})
		// Subscribe to MCP tool list changes so we can restart the SDK session
		// when servers are added/removed/reconnected. The SDK's DefaultSessionBuilder
		// does not support dynamic MCP tools, so we must restart the session.
		this.mcpHub.setToolListChangeCallback(() => this.mcpTools.handleToolListChanged())

		// Initialize gRPC bridge
		this.grpcBridge = new WebviewGrpcBridge(this.messageTranslatorState)

		// Wire the bridge to the controller's getStateToPostToWebview()
		// so state updates include messages, currentTaskItem, and task history
		this.grpcBridge.setGetStateFn(() => this.getStateToPostToWebview())

		this.sessionEventStream = this.messages
		this.homeContext = {
			translator: this.messageTranslatorState,
			turn: this.turnStateTracker,
			messages: this.messages,
			interactions: this.interactions,
		}

		// Register the bridge as a session event listener
		this.onSessionEvent(this.grpcBridge.createListener())

		// Restore auth state from secrets on startup, then start the remote
		// config polling timer (enterprise policy enforcement). The timer must
		// start after auth is restored so remote config can identify the user's
		// organization and apply org-level policies.
		this.authService
			.restoreRefreshTokenAndRetrieveAuthInfo()
			.then(async () => {
				try {
					await this.refreshRemoteConfig()
				} catch (err) {
					Logger.error("[SdkController] Initial remote config refresh failed:", err)
				}
				this.startRemoteConfigTimer()
			})
			.catch((err) => {
				Logger.error("[SdkController] Failed to restore auth state:", err)
			})
			.finally(() => {
				this.resolveInitialRemoteConfigReady()
			})

		Logger.log("[SdkController] Initialized with SDK adapter layer + gRPC bridge + auth services")
	}

	getProviderConfigStore(): ProviderConfigStore {
		return this.providerConfigStore
	}

	getProviderCatalog(): ProviderCatalog {
		return this.providerCatalog
	}

	invalidateProviderListings(): void {
		this.providerCatalog.invalidateProviderListings()
	}

	private handleProviderConfigChange(_event: ProviderConfigChange): void {
		this.scheduleProviderConfigStatePost()
	}

	/**
	 * Home picker draft lives only in this host, survives webview remounts, and is consumed
	 * by the next task-start attempt. It is never written to Settings or carried to later chats.
	 * Chats capture both modes at start and keep that selection when defaults change.
	 * Reset copies the current Settings default for the selected mode into this chat.
	 * One-turn choices are armed while idle, retain the prior selection in history,
	 * and restore it before deferred follow-ups are sent, including after cancel/error.
	 */
	private draftApiSelection?: TaskApiSelection

	/**
	 * Records a chat's per-mode selection as its last-used selection, pinned on
	 * the session context so provider-change rebuilds resolve against it, and
	 * persisted to session metadata so reopening the chat restores it.
	 */
	recordTaskApiSelection(
		taskId: string | undefined = this.task?.taskId,
		capturedSelection?: TaskApiSelection,
	): TaskApiSelection | undefined {
		if (!taskId) return undefined
		try {
			const selection =
				capturedSelection ?? this.taskSessions.get(taskId)?.apiSelection ?? captureTaskApiSelection(this.stateManager)
			const context = this.getTaskSessionContext(taskId)
			if (taskApiSelectionsEqual(context?.apiSelection, selection)) return selection
			if (context) context.apiSelection = selection
			void this.taskHistory
				.setTaskApiSelection(taskId, context?.nextMessageSelection?.previous ?? selection)
				.catch((error) => Logger.error(`[SdkController] Failed to persist API selection for ${taskId}:`, error))
			return selection
		} catch (error) {
			Logger.error("[SdkController] Failed to capture task API selection:", error)
			return undefined
		}
	}

	/**
	 * Snapshot of every task session's pinned selection, taken before a
	 * configuration rebuild — the provider-change coordinator uses
	 * it as the "before" side of each session's effective-config comparison.
	 */
	private snapshotTaskApiSelections(): Map<string, TaskApiSelection | undefined> {
		const snapshot = new Map<string, TaskApiSelection | undefined>()
		for (const [taskId, context] of this.taskSessions) {
			snapshot.set(taskId, context.apiSelection)
		}
		return snapshot
	}

	private deferOneTurnFollowup(
		id: string,
		prompt: string,
		images?: string[],
		files?: string[],
		delivery?: "queue" | "steer" | "interject",
	): boolean {
		const temporary = this.taskSessions.get(id)?.nextMessageSelection
		if (delivery === "interject") return false
		if (!temporary?.started || (!temporary.restoring && !delivery)) return false
		temporary.deferred.push({ prompt, images, files })
		return true
	}

	private refreshTaskApiModel(taskId: string): void {
		const context = this.taskSessions.get(taskId)
		const modelId = this.sessions.getSession(taskId)?.startConfig?.modelId
		if (context?.task && modelId) context.task.api = createTaskApiModelShim(modelId)
	}

	private commitTaskApiSelection(taskId: string, selection: TaskApiSelection, requestedSelection?: TaskApiSelection): void {
		const context = this.taskSessions.get(taskId)
		if (context && taskApiSelectionsEqual(context.pendingApiSelection, requestedSelection))
			context.pendingApiSelection = undefined
		const temporary = context?.nextMessageSelection
		const reverted = temporary?.restoring && taskApiSelectionsEqual(requestedSelection, temporary.previous)
		if (reverted && context) context.nextMessageSelection = undefined
		this.recordTaskApiSelection(taskId, selection)
		this.refreshTaskApiModel(taskId)
		if (reverted) {
			const session = this.sessions.getSession(taskId)
			if (session) {
				for (const [index, message] of temporary!.deferred.entries()) {
					this.sessions.markSendRunning(taskId)
					this.sessions.fireAndForgetSend(
						session.sdkHost,
						taskId,
						message.prompt,
						message.images,
						message.files,
						index === 0 ? undefined : "queue",
					)
				}
			}
		}
	}

	/** Restore chat state without writing Settings defaults. */
	private restoreTaskApiSelection(historyItem: HistoryItem | undefined, mode?: Mode): void {
		const taskId = historyItem?.id
		if (!taskId) return
		const context = this.getTaskSessionContext(taskId)
		const live = this.sessions.getSession(taskId)?.apiSnapshot?.selection
		if (context.apiSelection || context.pendingApiSelection) return
		const resolved = live ?? {
			...captureTaskApiSelection(this.stateManager),
			...resolveTaskApiSelection(this.stateManager, historyItem ?? {}, mode ?? context.mode),
		}
		this.recordTaskApiSelection(taskId, resolved)
	}

	/** Composer RPC. Only the Settings branch of assignApiProfile writes defaults. */
	async updateChatApiSelection(mode: Mode, request: AssignApiProfileRequest): Promise<void> {
		const taskId = this.task?.taskId
		if ((request.taskId || undefined) !== taskId) throw new Error("Focused chat changed during selection")
		const defaults = captureTaskApiSelection(this.stateManager)
		const context = taskId ? this.getTaskSessionContext(taskId) : undefined
		const session = taskId ? this.sessions.getSession(taskId) : undefined
		const current = context?.pendingApiSelection ?? context?.apiSelection ?? this.draftApiSelection ?? defaults
		const profileKey = mode === "plan" ? "askProfileId" : "actProfileId"
		const effortKey = `${mode}ModeReasoningEffort` as const
		if (request.reasoningEffort !== undefined && !isOpenaiReasoningEffort(request.reasoningEffort)) {
			throw new Error("Invalid reasoning effort")
		}
		const profile = request.profileId
			? readApiConfigProfiles(this.stateManager).find((p) => p.id === request.profileId)
			: undefined
		if (request.profileId && !profile) throw new Error("Unknown configuration")
		if (request.nextMessageOnly !== undefined) {
			if (!context) throw new Error("Next-message selection requires a chat")
			if (session?.isRunning || session?.queuedPromptCount || context.nextMessageSelection?.started) {
				throw new Error("Wait for this turn to finish before arming a one-turn selection")
			}
			if (request.nextMessageOnly && !context.nextMessageSelection) {
				context.nextMessageSelection = { previous: structuredClone(current), started: false, deferred: [] }
			} else if (!request.nextMessageOnly) {
				context.nextMessageSelection = undefined
				// A built temporary choice becomes durable when the user chooses Keep.
				if (taskId && taskApiSelectionsEqual(current, context.apiSelection)) {
					await this.taskHistory.setTaskApiSelection(taskId, current)
				}
			}
		}
		if (context?.nextMessageSelection?.started && !(request.resetToDefault && !session?.isRunning)) {
			throw new Error("Wait for the one-turn selection to revert")
		}
		const selection = { ...current }
		if (request.resetToDefault) {
			selection[profileKey] = defaults[profileKey]
			selection[effortKey] = defaults[effortKey]
			if (context?.nextMessageSelection?.started) {
				context.nextMessageSelection.previous = selection
				context.nextMessageSelection.restoring = true
			} else if (context) context.nextMessageSelection = undefined
		} else {
			if (profile) {
				selection[profileKey] = profile.id
				selection[effortKey] = profile.reasoningEffort ?? "none"
			}
			if (isOpenaiReasoningEffort(request.reasoningEffort)) selection[effortKey] = request.reasoningEffort
		}
		if (!context) {
			this.draftApiSelection = taskApiSelectionsEqual(selection, defaults) ? undefined : selection
		} else if (session) {
			context.pendingApiSelection = selection
			const configuration = this.stateManager.getApiConfiguration()
			this.providerChanges.handleApiConfigurationChanged(configuration, configuration, this.snapshotTaskApiSelections())
		} else {
			this.recordTaskApiSelection(taskId, selection)
		}
	}

	handleApiConfigurationChanged(
		previous: ApiConfiguration,
		next: ApiConfiguration,
		_selectionChanges: Partial<TaskApiSelection> = {},
	): void {
		// Existing chats keep their captured selection; saved profile edits still rebuild users of that profile.
		this.providerChanges.handleApiConfigurationChanged(previous, next, this.snapshotTaskApiSelections())
	}

	handleTerminalExecutionModeChanged(previous: VscodeTerminalExecutionMode, next: VscodeTerminalExecutionMode): void {
		this.sessionConfigChanges.handleTerminalExecutionModeChanged(previous, next)
	}

	handleSubagentSettingsChanged(): void {
		this.sessionConfigChanges.handleSubagentSettingsChanged()
	}

	handleCheckpointsSettingChanged(previous: boolean, next: boolean): void {
		this.sessionConfigChanges.handleCheckpointsSettingChanged(previous, next)
	}

	private handleSessionBecameIdle(): void {
		for (const [taskId, context] of this.taskSessions) {
			const temporary = context.nextMessageSelection
			const session = this.sessions.getSession(taskId)
			if (!temporary?.started || temporary.restoring || !session || session.isRunning || session.queuedPromptCount) continue
			temporary.restoring = true
			context.pendingApiSelection = temporary.previous
			const configuration = this.stateManager.getApiConfiguration()
			this.providerChanges.handleApiConfigurationChanged(configuration, configuration, this.snapshotTaskApiSelections())
		}
		this.mcpTools?.sessionBecameIdle()
		this.sessionRebuilds?.sessionBecameIdle()
	}

	private scheduleProviderConfigStatePost(): void {
		if (this.providerConfigStatePostScheduled) {
			return
		}

		this.providerConfigStatePostScheduled = true
		queueMicrotask(() => {
			this.providerConfigStatePostScheduled = false
			this.postStateToWebview().catch((error) => {
				Logger.error("[SdkController] Failed to post state after provider config change:", error)
			})
		})
	}

	/**
	 * Starts the periodic remote config fetching timer. Fetches immediately
	 * and then every hour, to enforce enterprise policy (provider lockdown,
	 * MCP server management, OpenTelemetry, etc.).
	 */
	private startRemoteConfigTimer(): void {
		// Set up 1-hour interval
		this.remoteConfigTimer = setInterval(() => {
			this.refreshRemoteConfig().catch((err) => Logger.error("[SdkController] Remote config timer failed:", err))
		}, 3600000) // 1 hour
	}

	async refreshRemoteConfig(options: { force?: boolean } = {}): Promise<boolean> {
		const userId = this.authService.getInfo().user?.uid ?? "signed-out"
		const organizationId = this.authService.getActiveOrganizationId() ?? "no-org"
		return this.remoteConfigRefreshCoordinator.refresh(`${userId}:${organizationId}`, options)
	}

	async waitForInitialRemoteConfig(): Promise<void> {
		await this.initialRemoteConfigReady
	}

	async rematerializeRemoteConfig(): Promise<void> {
		// force: this runs right after a toggle/opt-out mutation; coalescing onto
		// an in-flight refresh that sampled the pre-mutation state would report
		// success while applying the old configuration.
		const refreshed = await this.refreshRemoteConfig({ force: true })
		if (!refreshed) {
			throw new Error("Could not apply managed configuration change. Check your connection and try again.")
		}
		await this.sessions.endActiveSession("remoteConfigToggle", { awaitStop: true })
		await this.postStateToWebview()
	}

	private async ensureRemoteConfigForSessionStart(): Promise<void> {
		const startedAt = Date.now()
		await this.waitForInitialRemoteConfig()
		let refreshed = false
		try {
			refreshed = await this.refreshRemoteConfig()
		} catch (error) {
			// A rejected refresh must degrade to the same fallback logic as a
			// false return: otherwise a filesystem error on the clear path (e.g.
			// EACCES on the remote-config workspace) blocks even unmanaged users
			// from starting sessions with a raw fs error.
			Logger.error("[SdkController] Remote config refresh threw during session gate:", error)
		}
		const activeOrganizationId = this.authService.getActiveOrganizationId()
		if (refreshed) {
			void telemetryService.captureRemoteConfigSessionGate({
				outcome: "refreshed",
				durationMs: Date.now() - startedAt,
				managed: Boolean(activeOrganizationId),
			})
			return
		}

		if (!activeOrganizationId) {
			if (this.stateManager.getGlobalStateKey("lastManagedOrganizationId")) {
				// This install last ran under organization policy, but the current
				// identity could not be resolved (refresh failed and no org was
				// restored — e.g. the API is unreachable). Fail closed rather than
				// starting an unpoliced session.
				void telemetryService.captureRemoteConfigSessionGate({
					outcome: "blocked",
					durationMs: Date.now() - startedAt,
					managed: true,
				})
				throw new Error("Could not verify organization policy. Check your connection and try again.")
			}
			// No organization policy applies to personal or signed-out use; a
			// failed refresh must not block local work.
			void telemetryService.captureRemoteConfigSessionGate({
				outcome: "unmanaged",
				durationMs: Date.now() - startedAt,
				managed: false,
			})
			return
		}

		const bundleOrganizationId = this.remoteConfigBundle?.metadata?.organizationId
		if (bundleOrganizationId === activeOrganizationId) {
			Logger.warn("[SdkController] Remote config refresh failed; starting with last known-good organization policy")
			void telemetryService.captureRemoteConfigSessionGate({
				outcome: "last_known_good",
				durationMs: Date.now() - startedAt,
				managed: true,
			})
			return
		}
		void telemetryService.captureRemoteConfigSessionGate({
			outcome: "blocked",
			durationMs: Date.now() - startedAt,
			managed: true,
		})
		throw new Error("Could not verify organization policy. Check your connection and try again.")
	}

	private createRemoteConfigAwareSessionHost(): Promise<VscodeSessionHost> {
		return VscodeSessionHost.create({
			resolveNotebook: (input) => this.resolveTaskNotebook(input.config.sessionId, input.sessionMetadata),
			resolveThreadTranscript: (input) => this.resolveThreadTranscriptContext(input),
			mcpHub: this.mcpHub,
			beforeStartSession: () => this.ensureRemoteConfigForSessionStart(),
			getRemoteConfigIntegration: () => this.remoteConfigCoreIntegration,
		})
	}

	private async performRemoteConfigRefresh(isCurrent: () => boolean): Promise<boolean> {
		const refreshed = await refreshSdkRemoteConfig(this, {
			workspacePath: await this.getRemoteConfigWorkspacePath(),
			isCurrent,
		})
		if (!isCurrent()) {
			return false
		}
		// Remote config may have materialized new workflows/skills/rules under
		// `.cline/remote-config/`. Refresh the watcher so slash-command expansion
		// sees them without waiting on filesystem events.
		await this.refreshUserInstructionWatchers()
		return refreshed
	}

	setRemoteConfigAvailable(available: boolean): void {
		this.remoteConfigAvailable = available
	}

	async setRemoteConfigCoreIntegration(integration: PreparedRemoteConfigCoreIntegration | undefined): Promise<void> {
		const previous = this.remoteConfigCoreIntegration
		this.remoteConfigCoreIntegration = integration
		if (previous !== integration) {
			this.remoteConfigRevision += 1
		}
		if (previous && previous !== integration) {
			try {
				await previous.dispose()
			} catch (error) {
				Logger.error("[SdkController] Failed to dispose previous remote config integration:", error)
			}
		}
	}

	async invalidateUserInstructionService(): Promise<void> {
		const userInstructionServicePromise = this.userInstructionService
		this.userInstructionService = undefined
		this.userInstructionServiceRoot = undefined
		if (userInstructionServicePromise) {
			await userInstructionServicePromise.then((service) => service.stop()).catch(() => {})
		}
	}

	async dispose(): Promise<void> {
		for (const editor of this.notebookEditors) editor.dispose()
		this.providerConfigStoreSubscription.dispose()
		// Clear the remote config timer to prevent stale fetches
		if (this.remoteConfigTimer) {
			clearInterval(this.remoteConfigTimer)
			this.remoteConfigTimer = undefined
		}
		await this.setRemoteConfigCoreIntegration(undefined)
		this.isDisposed = true
		await this.taskHistory.flushMetadataWrites()
		// Tear down the debounced state-post machinery before downstream resources
		// are disposed below — see StatePostDebouncer.dispose().
		await this.statePostDebouncer.dispose()
		await this.invalidateUserInstructionService()
		this.messages.cancelPendingSave()
		// Clear MCP tool list change callback before disposing McpHub
		this.mcpHub?.clearToolListChangeCallback()
		await this.diffEdits.discardAllPreviews("controller dispose")
		await this.clearTask()
		for (const context of this.taskSessions.values()) {
			context.interactions.clearPending("Controller disposed")
			context.watchdog.stop()
			context.messages.dispose()
		}
		this.taskSessions.clear()
		await this.sessions.dispose("SdkController.dispose")
		await this.taskHistory.dispose()
		await this.taskGroupsWatcher?.close()
		await this.currentBranchWatcher.dispose()
		this.mcpHub?.dispose?.()
		this.messages.dispose()
		await this.sdkTelemetry.dispose()
		Logger.log("[SdkController] Disposed")
	}

	private handleParentSessionReplaced(id: string): void {
		const owner = this.taskSessions.get(id)
		owner?.interactions.clearPending("Parent session replaced")
		if (owner?.turn?.currentPhase === "streaming") owner.turn.set("completed")
		this.sessions.setStatus(id, "done")
		for (const child of this.subagentThreads.values()) {
			if (
				(child.runtimeOwnerTaskId ?? child.parentTaskId) !== id ||
				!["running", "waiting"].includes(this.sessions.sessionStatuses[child.id])
			)
				continue
			const context = this.getTaskSessionContext(child.id)
			context.messages.appendMessages([
				{
					ts: context.translator.nextTs(),
					type: "say",
					say: "error",
					text: "Subagent stopped because its parent session was rebuilt.",
				},
			])
			context.turn.set("error")
			this.sessions.setStatus(child.id, "error")
		}
		void this.postStateToWebview()
	}

	/** Child events are translated once into their own transcript, never into siblings. */
	private handleSubagentEvent(event: CoreSessionEvent): boolean {
		if (event.type === "subagent") {
			const payload = event.payload
			const owner = this.taskSessions.get(payload.sessionId)
			if (!owner || !this.sessions.getSession(payload.sessionId)) return true
			const immediateParent = Array.from(this.subagentThreads?.values() ?? []).find(
				(child) =>
					(child.runtimeOwnerTaskId ?? child.parentTaskId) === payload.sessionId &&
					child.agentId === payload.parentAgentId,
			)
			const parentTaskId = immediateParent?.id ?? payload.sessionId
			const parent = this.taskSessions.get(parentTaskId)
			const existing = this.subagentThreads?.get(payload.childSessionId)
			const item: HistoryItem = {
				id: payload.childSessionId,
				ts: existing?.ts ?? Date.now(),
				task: payload.prompt,
				tokensIn: existing?.tokensIn ?? 0,
				tokensOut: existing?.tokensOut ?? 0,
				totalCost: existing?.totalCost ?? 0,
				cacheReads: existing?.cacheReads ?? 0,
				cacheWrites: existing?.cacheWrites ?? 0,
				subagentToolCalls: existing?.subagentToolCalls ?? 0,
				isSubagent: true,
				parentTaskId,
				runtimeOwnerTaskId: payload.sessionId,
				agentId: payload.agentId,
				spawnToolCallId: payload.toolCallId,
				subagentAccess: payload.access,
			}
			this.subagentThreads.set(item.id, item)
			const context = this.getTaskSessionContext(item.id)
			context.mode = payload.access === "write" ? "act" : "plan"
			if (!existing)
				context.messages.appendMessages([
					{ ts: context.translator.nextTs(), type: "say", say: "task", text: payload.prompt },
				])
			context.turn.set(payload.status === "running" ? "streaming" : payload.status === "failed" ? "error" : "completed")
			this.sessions.setStatus(
				item.id,
				payload.status === "running"
					? "running"
					: payload.status === "failed" || payload.status === "cancelled"
						? "error"
						: "done",
			)
			if (payload.status !== "running") owner.interactions?.clearPending("Subagent ended", payload.agentId)
			const spawn = payload.toolCallId ? parent?.translator.getSpawnAgent(payload.toolCallId) : undefined
			if (spawn) spawn.childSessionId = item.id
			this.taskHistory.invalidateMetadataHistoryCache()
			void this.postStateToWebview()
			return true
		}
		if (event.type !== "agent_event" || !event.payload.event.parentAgentId) return false
		const child = Array.from(this.subagentThreads?.values() ?? []).find(
			(item) =>
				(item.runtimeOwnerTaskId ?? item.parentTaskId) === event.payload.sessionId &&
				item.agentId === event.payload.event.agentId,
		)
		if (!child) return true
		const context = this.getTaskSessionContext(child.id)
		const result = translateSessionEvent(event, context.translator, child.agentId)
		if (event.payload.event.type === "content_start" && event.payload.event.contentType === "tool")
			child.subagentToolCalls = (child.subagentToolCalls ?? 0) + 1
		if (result.usage) {
			child.tokensIn += result.usage.tokensIn
			child.tokensOut += result.usage.tokensOut
			child.totalCost = (child.totalCost ?? 0) + (result.usage.totalCost ?? 0)
			child.cacheReads = (child.cacheReads ?? 0) + (result.usage.cacheReads ?? 0)
			child.cacheWrites = (child.cacheWrites ?? 0) + (result.usage.cacheWrites ?? 0)
		}
		context.messages.appendAndEmit(result.messages, { ...event, payload: { ...event.payload, sessionId: child.id } })
		if (result.turnComplete) context.turn.set(context.translator.wasErrorSeen() ? "error" : "completed")
		void this.postStateToWebview()
		return true
	}

	private async resolveTaskSessionId(conversationId: string): Promise<string> {
		if (this.sessions.getSession(conversationId)) return conversationId
		for (const [id, session] of this.sessions.getSessions()) {
			const record = await session.sdkHost.get(id)
			if (record?.conversationId === conversationId) return id
		}
		throw new Error(`No live task for conversation ${conversationId}`)
	}

	private getTaskSessionContext(id: string, task?: TaskProxy): TaskSessionContext {
		const existing = this.taskSessions.get(id)
		if (existing) {
			if (task) existing.task = task
			return existing
		}
		const session = this.sessions.getSession(id)
		const mode = session?.startConfig?.mode ?? (this.stateManager.getGlobalSettingsKey("mode") === "plan" ? "plan" : "act")
		const translator = new MessageTranslatorState(
			this.homeContext?.translator.getMinter() ?? this.messageTranslatorState.getMinter(),
			() => this.sessions.getSession(id)?.startConfig?.providerId,
			() => context.mode,
			() => this.lastKnownWorkspaceRoot,
			() => this.sessions.getSession(id)?.startConfig?.modelId,
		)
		const turn = new TurnStateTracker(translator.getMinter())
		const messages = new SdkMessageCoordinator({
			getTask: () => context.task,
			getMinter: () => translator.getMinter(),
			isFocused: () => this.task?.taskId === id,
		})
		messages.onSessionEvent((updates, event) => {
			if (event.type === "status" && event.payload.status === "error") setPhase("error")
			if (this.task?.taskId === id) this.sessionEventStream.emitSessionEvents(updates, event)
		})
		const hasActiveTurn = () =>
			turn.currentPhase === "streaming" ||
			turn.currentPhase === "awaiting_approval" ||
			(turn.currentPhase === "awaiting_followup" && this.sessions.getSession(id)?.isRunning === true)
		const setPhase = (phase: TurnPhase, anchorTs?: number) => {
			turn.set(phase, anchorTs)
			if (hasActiveTurn()) watchdog.activity()
			else watchdog.stop()
			this.sessions.setStatus(
				id,
				phase === "awaiting_approval" || (phase === "awaiting_followup" && this.sessions.getSession(id)?.isRunning)
					? "waiting"
					: phase === "streaming"
						? "running"
						: phase === "error"
							? "error"
							: "done",
			)
		}
		const watchdog = new TurnActivityWatchdog(
			() => context.interactions.hasPendingUserDecision(),
			() => {
				if (!hasActiveTurn() || context.cancelled) return
				context.cancelled = true
				translator.setErrorSeen()
				setPhase("error")
				this.sessions.setRunning(false, id)
				messages.appendAndEmit(
					[
						{
							ts: translator.nextTs(),
							type: "ask",
							ask: "api_req_failed",
							partial: false,
							text: "The agent stopped responding for 2 minutes with no pending approval or question. Retry to continue this turn.",
						},
					],
					{ type: "status", payload: { sessionId: id, status: "error" } },
				)
				void this.postStateToWebview()
				const session = this.sessions.getSession(id)
				void session?.sdkHost.abort(id).catch((error) => Logger.warn("Failed to abort stalled turn", error))
			},
		)

		const interactions = new SdkInteractionCoordinator({
			messages,
			onDecisionMessage: (agentId, message) => {
				const child = Array.from(this.subagentThreads?.values() ?? []).find(
					(item) => (item.runtimeOwnerTaskId ?? item.parentTaskId) === id && item.agentId === agentId,
				)
				if (child) {
					message.subagentTaskId = child.id
					message.subagentName = child.task
					this.getTaskSessionContext(child.id).messages.appendAndEmit([{ ...message }], {
						type: "status",
						payload: { sessionId: child.id, status: "running" },
					})
				}
			},
			getSessionId: () => id,
			getMode: () => context.mode,
			getMinter: () => translator.getMinter(),
			postStateToWebview: () => this.postStateToWebview(),
			setTurnPhase: setPhase,
			getCwd: (sessionId) => this.sessions.getSession(sessionId ?? id)?.startConfig?.cwd ?? this.lastKnownWorkspaceRoot,
			onToolApprovalAsk: (request) =>
				this.task?.taskId === id
					? this.diffEdits.openForApproval(request.toolCallId, request.toolName, request.input, request.sessionId ?? id)
					: Promise.resolve(),
			recordApprovedToolMessage: (callId, ts, agentId) => {
				const child = Array.from(this.subagentThreads?.values() ?? []).find(
					(item) => (item.runtimeOwnerTaskId ?? item.parentTaskId) === id && item.agentId === agentId,
				)
				const ownerTranslator = child ? this.getTaskSessionContext(child.id).translator : translator
				ownerTranslator.recordApprovedToolMessageTs(callId, ts)
			},
			recordDeniedToolApproval: (callId, name, reason, agentId) => {
				const child = Array.from(this.subagentThreads?.values() ?? []).find(
					(item) => (item.runtimeOwnerTaskId ?? item.parentTaskId) === id && item.agentId === agentId,
				)
				const ownerTranslator = child ? this.getTaskSessionContext(child.id).translator : translator
				ownerTranslator.recordDeniedToolApproval(callId, name, reason)
				void this.diffEdits.discardPreview(callId)
			},
			shouldAutoApproveTool: (request) => {
				const settings = this.stateManager.getGlobalSettingsKey("autoApprovalSettings")
				return settings ? isToolAutoApproved(request.toolName, settings) : false
			},
			prepareScriptApproval: (request, scriptMode) =>
				this.scripts.prepareApproval(
					request,
					scriptMode,
					id,
					this.sessions.getSession(request.sessionId ?? id)?.startConfig?.cwd ?? this.lastKnownWorkspaceRoot,
				),
			completeScriptApproval: (request, approved, trust) => this.scripts.completeApproval(request, approved, trust),
		})
		const events = new SdkSessionEventCoordinator({
			onRuntimeActivity: () => {
				if (hasActiveTurn()) watchdog.activity()
			},
			onTurnComplete: () => this.emitNotebookChanges(id),
			sessionId: id,
			messageTranslatorState: translator,
			sessions: this.sessions,
			messages,
			taskHistory: this.taskHistory,
			stateManager: this.stateManager,
			getTask: () => context.task,
			postStateToWebview: () => this.postStateToWebview(),
			setTurnPhase: setPhase,
			getTurnPhase: () => turn.currentPhase,
			getProviderId: () => this.sessions.getSession(id)?.startConfig?.providerId,
			getModelId: () => this.sessions.getSession(id)?.startConfig?.modelId,
			isTurnCancelled: () => context.cancelled,
			onTurnStarted: () => {
				context.cancelled = false
			},
			captureProviderApiError: (event) => this.captureProviderFailure(event),
		})
		const context: TaskSessionContext = {
			task:
				task ??
				createTaskProxy(
					id,
					(text, images, files, decisionId, provenance) =>
						this.askResponse(text, images, files, decisionId, provenance),
					() => this.cancelTask(),
				),
			translator,
			turn,
			messages,
			interactions,
			events,
			watchdog,
			mode,
			cancelled: false,
			apiSelection: session?.apiSnapshot?.selection,
		}
		this.taskSessions.set(id, context)
		if (!this.sessions.getSession(id) && task?.messageStateHandler.getClineMessages().length === 0) setPhase("streaming")
		return context
	}

	/**
	 * Displayable HistoryItem for a session that is live but absent from
	 * persisted history — Core only writes the record when the first send
	 * lands, so without this a just-backgrounded chat vanishes from the inbox
	 * and cannot be reopened. The title comes from the session's own transcript
	 * (the say:task message emitted at start); cwd fills in at the call site.
	 */
	private liveTaskHistoryItem(taskId: string): HistoryItem | undefined {
		const session = this.sessions.getSession(taskId)
		if (!session) {
			return undefined
		}
		const context = this.taskSessions.get(taskId)
		const taskProxy = this.task?.taskId === taskId ? this.task : context?.task
		const taskMessage = taskProxy?.messageStateHandler
			.getClineMessages()
			.find((message) => message.type === "say" && message.say === "task" && message.text)
		if (!taskMessage?.text) {
			return undefined
		}
		return {
			id: taskId,
			ts: taskMessage.ts || Date.now(),
			task: taskMessage.text,
			tokensIn: 0,
			tokensOut: 0,
			cacheWrites: 0,
			cacheReads: 0,
			totalCost: 0,
			modelId: session.startConfig?.modelId ?? taskProxy?.api?.getModel?.().id,
			cwdOnTaskInitialization: this.lastKnownWorkspaceRoot,
			taskGroupId: context?.taskGroupId,
		}
	}

	// ---- Slash command + context mention resolution ----

	/**
	 * Lazily create (or rebuild on workspace-root change) the user-instruction
	 * watcher. Pointed at the workspace root so it discovers both local config
	 * (`.clinerules/workflows`, `.cline/workflows`, …) and remote-config files
	 * materialized under `<root>/.cline/remote-config/{workflows,skills,rules}`.
	 *
	 * `workspaceRoot` is resolved by the caller so the memoization check below runs
	 * synchronously on entry — there is no `await` before the assignment, so
	 * concurrent callers cannot create two competing watchers.
	 */
	private ensureUserInstructionService(workspaceRoot: string): Promise<UserInstructionConfigService> {
		// dispose() may have run during an awaited gap in the caller. Don't
		// resurrect a watcher the dispose path will never stop again.
		if (this.isDisposed) {
			return Promise.reject(new Error("Controller disposed"))
		}
		if (this.userInstructionService && this.userInstructionServiceRoot === workspaceRoot) {
			return this.userInstructionService
		}
		// Workspace root changed: stop the previous watcher once it settles.
		const previous = this.userInstructionService
		if (previous) {
			previous.then((service) => service.stop()).catch(() => {})
		}
		this.userInstructionServiceRoot = workspaceRoot
		this.userInstructionService = (async () => {
			const service = createUserInstructionConfigService({
				workflows: { workspacePath: workspaceRoot },
				skills: {
					workspacePath: workspaceRoot,
					includePluginSkills: true,
					cwd: workspaceRoot,
				},
				rules: { workspacePath: workspaceRoot },
			})
			// start() runs the initial scan; await so the snapshot is populated
			// before the first resolveRuntimeSlashCommand call.
			await service.start().catch((error) => {
				Logger.warn("[SdkController] Failed to start user instruction watcher:", error)
			})
			return service
		})()
		return this.userInstructionService
	}

	/**
	 * Expand a `/workflow` or `/skill` slash command into its instruction body.
	 * Serves the same purpose as the CLI's `buildUserInputMessage`, but is more
	 * permissive than the SDK's leading-only resolver: it accepts the legacy
	 * `/my-workflow.md` spelling the webview autocomplete inserts, matches
	 * commands mid-message (anything the chat input highlights as a command),
	 * and honors the user's workflow enable/disable toggles. Returns the input
	 * unchanged if no known command matches or expansion fails.
	 */
	private async resolveSlashCommands(text: string, threadId?: string, provenance?: ComposerProvenance): Promise<string> {
		if (this.isDisposed) {
			return text
		}
		try {
			// `/script-name option:value` runs a saved script; it wins over a workflow of the same name.
			// Only the composer's script marker grants a one-run approval; the same text from anywhere
			// else still expands but goes through normal approval.
			const scriptRun = threadId
				? await this.scripts.expandInvocation(text, threadId, provenance?.scriptInvocation)
				: undefined
			if (scriptRun) {
				return scriptRun
			}
			const workspaceRoot = await this.getWorkspaceRoot()
			const service = await this.ensureUserInstructionService(workspaceRoot)
			const remoteWorkflows = this.stateManager.getRemoteConfigSettings()?.remoteGlobalWorkflows ?? []
			const workflowRecords = service.listRecords("workflow").map((record) => ({
				id: record.id,
				name: record.item.name,
				filePath: record.filePath,
			}))
			const disabledWorkflowNames = buildDisabledWorkflowNames({
				records: workflowRecords,
				globalToggles: this.stateManager.getGlobalSettingsKey("globalWorkflowToggles"),
				workspaceToggles: this.stateManager.getWorkspaceStateKey("workflowToggles"),
				remoteToggles: this.stateManager.getGlobalStateKey("remoteWorkflowToggles"),
				remoteAlwaysEnabledNames: remoteWorkflows.filter((workflow) => workflow.alwaysEnabled).map((w) => w.name),
			})
			return expandSlashCommands(text, [...service.listRuntimeCommands(), ...BUILTIN_SLASH_COMMANDS], {
				disabledWorkflowNames,
				workflowRecords,
			})
		} catch (error) {
			Logger.warn("[SdkController] Slash command resolution failed, using raw text:", error)
			return text
		}
	}

	/**
	 * Refresh the user-instruction watcher after remote config is (re)materialized
	 * so newly written workflows/skills/rules are picked up immediately rather than
	 * waiting on filesystem watch events.
	 */
	private async refreshUserInstructionWatchers(): Promise<void> {
		const servicePromise = this.userInstructionService
		if (!servicePromise) {
			return
		}
		try {
			const service = await servicePromise
			await Promise.all([service.refreshType("workflow"), service.refreshType("skill"), service.refreshType("rule")])
		} catch (error) {
			Logger.warn("[SdkController] Failed to refresh user instruction watchers:", error)
		}
	}

	/**
	 * Expand slash commands, then resolve `@` context mentions in user text
	 * before sending to the SDK.
	 *
	 * `parseMentions()` inlines file content (`@/path`), URL content
	 * (`@https://...`), diagnostics (`@problems`), git state (`@git-changes`),
	 * and commit info (`@hash`) into the prompt text. We do this here because
	 * the SDK's own mention enricher only handles simple `@path` file mentions
	 * and does not understand the webview's `@/path` format or special
	 * mentions, so the LLM would otherwise never see the referenced content.
	 */
	private async resolveContextMentions(
		text: string,
		threadId = this.task?.taskId,
		provenance?: ComposerProvenance,
	): Promise<string> {
		// Only what the user explicitly did in the composer (`provenance`) authorizes
		// transcript access or a one-run script grant. `text` also holds quote chips,
		// walkthrough hunks, "Add to Cline" insertions and expanded notes/files/workflows,
		// so nothing is inferred from it; callers without provenance (host-built
		// prompts, task-creation URIs) authorize nothing.
		const authorizedThreads = authorizedThreadIds(provenance)
		// Message tags attach one message each as context; they never touch `authorizedThreads`.
		const messageLinks = messageLinkRefs(provenance)
		const finish = async (resolved: string): Promise<string> =>
			messageLinks.length === 0
				? resolved
				: prependMessageReferences(resolved, await this.resolveMessageReferenceBlocks(messageLinks))
		const withCommands = await this.resolveSlashCommands(text, threadId, provenance)
		let resolved = withCommands

		// Quick check: skip mention parsing if there are no @ mentions
		if (!mentionRegexGlobal.test(withCommands)) {
			return finish(await this.resolveReferenceMentions(withCommands, threadId, authorizedThreads))
		}
		// Reset lastIndex since RegExp.test() advances it for global regexes
		mentionRegexGlobal.lastIndex = 0

		try {
			const mapping = threadId ? await this.threadWorktrees.get(threadId) : undefined
			const removed = !mapping && threadId ? await this.threadWorktrees.removedWorkspace(threadId) : undefined
			const cwd = mapping?.cwd ?? removed?.workspace ?? (await this.getWorkspaceRoot())
			const urlContentFetcher = new UrlContentFetcher()
			const workspaceManager = mapping
				? await WorkspaceRootManager.fromPaths(mapping.modules.map((module) => module.path))
				: removed
					? await WorkspaceRootManager.fromPaths([removed.workspace])
					: await this.ensureWorkspaceManager()
			resolved = await parseMentions(withCommands, cwd, urlContentFetcher, undefined, workspaceManager)
			Logger.log(`[SdkController] Resolved context mentions (${withCommands.length} → ${resolved.length} chars)`)
		} catch (error) {
			Logger.error("[SdkController] Failed to resolve context mentions, using raw text:", error)
		}
		return finish(await this.resolveReferenceMentions(resolved, threadId, authorizedThreads))
	}

	/** Context blocks for the message tags the user attached (links that no longer resolve are skipped). */
	private async resolveMessageReferenceBlocks(links: readonly MessageLinkRef[]): Promise<string[]> {
		const blocks: string[] = []
		for (const link of links) {
			// A reference carried verbatim (an edited message resending the tags it already had)
			// keeps its text: the linked message may be past the rewind point by now.
			if (link.text) {
				blocks.push(
					formatMessageReference({
						threadId: link.threadId,
						threadTitle: link.threadTitle ?? "",
						author: link.author === "user" ? "user" : "assistant",
						text: link.text,
					}),
				)
				continue
			}
			try {
				const info = await this.resolveMessageLink(link.threadId, link.messageIndex, {
					toolCallId: link.toolCallId,
					block: link.block,
				})
				if (info.text)
					blocks.push(
						formatMessageReference({
							...info,
							threadId: link.threadId,
							author: info.author === "user" ? "user" : "assistant",
						}),
					)
			} catch (error) {
				Logger.warn(`[SdkController] Failed to resolve message tag for thread ${link.threadId}:`, error)
			}
		}
		return blocks
	}

	private async resolveReferenceMentions(
		text: string,
		threadId: string | undefined,
		authorizedThreads: ReadonlySet<string>,
	): Promise<string> {
		const withNotes = await this.resolveTaskNoteMentions(text, threadId)
		return this.resolveThreadMentions(withNotes, threadId, authorizedThreads)
	}

	/**
	 * `#slug` and cross-task `#<group>/<slug>` mentions. The current task's
	 * notebook resolves first (including staged-but-uncommitted changes);
	 * every other task group is searched after it, most recently updated
	 * first. `<group>` is a group id or its slugified title.
	 */
	private async resolveTaskNoteMentions(text: string, threadId?: string): Promise<string> {
		if (!text.includes("#")) return text
		const notebook = threadId ? await this.resolveTaskNotebook(threadId) : undefined
		const otherGroups = (await this.taskGroupStore.listGroups()).filter((group) => group.id !== notebook?.group.id)
		if (!notebook && otherGroups.length === 0) return text
		const orderedGroups = notebook ? [notebook.group, ...otherGroups] : otherGroups
		return expandTaskNoteMentions(text, async (slug, qualifier) => {
			// A qualified mention tries its group first, then falls back to the
			// global search so a renamed task still resolves.
			const candidates = qualifier
				? [
						...orderedGroups.filter((group) => group.id === qualifier || slugifyNoteName(group.title) === qualifier),
						...orderedGroups,
					]
				: orderedGroups
			for (const group of candidates) {
				const note =
					group.id === notebook?.group.id
						? await notebook!.store.readThreadNote(group.id, notebook!.rootThreadId, slug, threadId!)
						: await this.notebookStore.readNote(group.id, slug, threadId)
				if (!note) continue
				const name = "meta" in note ? note.meta.name : note.name
				return {
					name,
					content: note.content,
					taskTitle: group.id !== notebook?.group.id ? group.title : undefined,
				}
			}
			return undefined
		})
	}

	/**
	 * Threads the user picked from the composer's `thread:` menu. Each picked
	 * thread joins this conversation's allow-list so the grep_threads/read_thread
	 * tools can open it, and its `thread:<id>` token expands to the thread's id
	 * and title (never its transcript). Nothing is derived from the text: a
	 * `thread:<id>` that was not picked stays literal and authorizes nothing.
	 */
	private async resolveThreadMentions(
		text: string,
		threadId: string | undefined,
		authorizedThreads: ReadonlySet<string>,
	): Promise<string> {
		if (authorizedThreads.size === 0) return text
		const known = new Map<string, { id: string; title: string } | undefined>()
		for (const id of authorizedThreads) {
			const item = await this.taskHistory.findHistoryItem(id)
			known.set(id, item ? { id: item.id, title: item.title || item.task } : undefined)
		}
		const resolvedIds = [...known.values()].filter((thread) => thread !== undefined).map((thread) => thread.id)
		if (threadId && resolvedIds.length > 0) {
			const owner = await this.resolveAllowListOwner(threadId)
			this.rememberThreadReferences(owner, resolvedIds)
		}
		if (!text.includes("thread:")) return text
		const { text: resolved } = await expandThreadMentions(text, async (id) => known.get(id), authorizedThreads)
		return resolved
	}

	/**
	 * The thread that owns a conversation's thread-reference allow-list: the
	 * user-facing thread itself, or the root thread for subagent sessions.
	 */
	private async resolveAllowListOwner(threadId: string): Promise<string> {
		const item = await this.taskHistory.findHistoryItem(threadId)
		if (!item) return threadId
		const owner = await resolveNotebookOwner(item, (id) => this.taskHistory.findHistoryItem(id))
		return owner.rootThreadId
	}

	private rememberThreadReferences(ownerThreadId: string, threadIds: string[]): void {
		let allowed = this.referencedThreads.get(ownerThreadId)
		if (!allowed) {
			allowed = new Set()
			this.referencedThreads.set(ownerThreadId, allowed)
		}
		for (const id of threadIds) allowed.add(id)
		void this.taskHistory.addReferencedThreads(ownerThreadId, threadIds).catch((error) => {
			Logger.warn("[SdkController] Failed to persist referenced threads:", error)
		})
	}

	private async isThreadReferenced(ownerThreadId: string, threadId: string): Promise<boolean> {
		if (this.referencedThreads.get(ownerThreadId)?.has(threadId)) return true
		return (await this.taskHistory.getReferencedThreads(ownerThreadId)).includes(threadId)
	}

	/**
	 * Context for the grep_threads/read_thread host tools. The allow-list is
	 * scoped to the user-facing thread that owns the calling session — a
	 * subagent inherits its owning thread's mentioned references.
	 */
	private async resolveThreadTranscriptContext(input: {
		config: { sessionId?: string }
	}): Promise<ThreadTranscriptToolsContext | undefined> {
		const sessionId = input.config.sessionId
		if (!sessionId) return undefined
		return {
			resolveOwnerThreadId: (toolContext) => this.resolveAllowListOwner(toolContext.sessionId ?? sessionId),
			isThreadAllowed: (ownerThreadId, threadId) => this.isThreadReferenced(ownerThreadId, threadId),
			listAllowedThreads: async (ownerThreadId) => {
				const persisted = await this.taskHistory.getReferencedThreads(ownerThreadId)
				const ids = [...new Set([...(this.referencedThreads.get(ownerThreadId) ?? []), ...persisted])]
				const threads = await Promise.all(
					ids.map(async (id) => {
						const item = await this.taskHistory.findHistoryItem(id)
						return item ? { id, title: item.title || item.task } : undefined
					}),
				)
				return threads.filter((thread): thread is { id: string; title: string } => thread !== undefined)
			},
			readTranscript: (threadId) => this.taskHistory.readSessionTranscript(threadId),
		}
	}

	// ---- Workspace root resolution ----

	/**
	 * Get the user's workspace root directory.
	 *
	 * In VSCode this resolves to `vscode.workspace.workspaceFolders[0]` via
	 * `HostProvider.workspace.getWorkspacePaths()`. If no workspace folder is
	 * open, it falls back to the SDK's shared chat workspace (see
	 * getNoWorkspaceFallback).
	 * This avoids using the VS Code extension host's `process.cwd()` (often `/`),
	 * which produces invalid SDK workspace metadata with an empty hint.
	 */
	async getWorkspaceRoot(): Promise<string> {
		try {
			const { paths } = await HostProvider.workspace.getWorkspacePaths({})
			const workspaceRoot = paths?.find((workspacePath) => workspacePath.trim().length > 0)
			if (workspaceRoot) {
				this.lastKnownWorkspaceRoot = workspaceRoot
				void this.currentBranchWatcher.setRoot(workspaceRoot).catch(() => {})
				return workspaceRoot
			}
		} catch (error) {
			Logger.warn("[SdkController] Failed to get workspace paths, using the no-workspace fallback:", error)
		}
		this.lastKnownWorkspaceRoot = await this.getNoWorkspaceFallback()
		void this.currentBranchWatcher.setRoot(this.lastKnownWorkspaceRoot).catch(() => {})
		return this.lastKnownWorkspaceRoot
	}

	private noWorkspaceFallbackPromise?: Promise<string>

	/**
	 * Directory used when no workspace folder is open: the SDK's shared chat
	 * workspace (`~/.cline/data/workspaces/chat`, seeded with an AGENTS.md
	 * etiquette file), matching how the desktop app and CLI host sessions
	 * started without a project. Desktop is only a last resort when the chat
	 * workspace cannot be created. Memoized so repeated no-workspace calls
	 * don't re-touch the filesystem.
	 */
	private getNoWorkspaceFallback(): Promise<string> {
		this.noWorkspaceFallbackPromise ??= (async () => {
			try {
				return await ensureChatWorkspace()
			} catch (error) {
				Logger.warn("[SdkController] Failed to prepare the chat workspace, falling back to Desktop:", error)
				// Don't memoize the degraded result; retry the chat workspace next time.
				this.noWorkspaceFallbackPromise = undefined
				return getDesktopDir()
			}
		})()
		return this.noWorkspaceFallbackPromise
	}

	private async getRemoteConfigWorkspacePath(): Promise<string | undefined> {
		try {
			const { paths } = await HostProvider.workspace.getWorkspacePaths({})
			if (!paths.length) {
				return undefined
			}
			return resolveWorkspaceRootPath(paths, paths[0])
		} catch (error) {
			Logger.warn("[SdkController] Failed to get workspace paths for remote config, using global fallback:", error)
			return undefined
		}
	}

	// ---- Session event subscription ----

	/**
	 * Subscribe to session events translated to ClineMessages.
	 * Returns an unsubscribe function.
	 */
	onSessionEvent(listener: SessionEventListener): () => void {
		return this.sessionEventStream.onSessionEvent(listener)
	}

	/**
	 * Get the active API provider for the current mode.
	 */
	private getActiveProviderId(): string | undefined {
		try {
			const apiConfig = this.stateManager.getApiConfiguration()
			const modeValue = this.stateManager.getGlobalSettingsKey("mode")
			const mode = modeValue === "plan" ? "plan" : "act"
			return mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider
		} catch {
			return undefined
		}
	}

	private getTaskModelId(): string | undefined {
		const modelId = this.task?.api?.getModel?.().id?.trim()
		return modelId && modelId !== "unknown" ? modelId : undefined
	}

	private getSessionProviderId(sessionId?: string): string | undefined {
		const activeSession = sessionId ? this.sessions.getSession(sessionId) : this.sessions.getActiveSession()
		if (sessionId && activeSession?.sessionId !== sessionId) {
			return undefined
		}
		const providerId =
			activeSession?.startResult?.manifest?.provider?.trim() || activeSession?.startConfig?.providerId?.trim()
		return providerId && providerId !== "unknown" ? providerId : undefined
	}

	private getSessionModelId(sessionId?: string): string | undefined {
		const activeSession = sessionId ? this.sessions.getSession(sessionId) : this.sessions.getActiveSession()
		if (sessionId && activeSession?.sessionId !== sessionId) {
			return undefined
		}
		const modelId = activeSession?.startResult?.manifest?.model?.trim() || activeSession?.startConfig?.modelId?.trim()
		return modelId && modelId !== "unknown" ? modelId : undefined
	}

	private beginProviderFailureTelemetryTurn(): void {
		this.providerFailureTelemetryTurnGate.beginTurn()
	}

	/**
	 * Check if the active API provider uses Cline account auth for the current mode.
	 */
	private isClineManagedProviderActive(): boolean {
		return isClineManagedProvider(this.getActiveProviderId())
	}

	private captureProviderFailure(event: ProviderFailureTelemetry): void {
		const ulid = event.sessionId ?? this.task?.taskId ?? this.sessions.getActiveSession()?.sessionId
		if (!ulid) {
			return
		}
		if (
			event.failurePhase === PROVIDER_FAILURE_PHASE.STREAMING &&
			!this.providerFailureTelemetryTurnGate.shouldCaptureStreamingFailure()
		) {
			return
		}

		const provider = event.providerId ?? this.getSessionProviderId(event.sessionId) ?? "unknown"
		const model = event.modelId ?? this.getSessionModelId(event.sessionId) ?? this.getTaskModelId() ?? "unknown"
		const clineError = ClineError.transform(event.error, model, provider)

		telemetryService.captureProviderApiError({
			ulid,
			model,
			provider,
			errorMessage: clineError.message || String(event.error),
			errorStatus: clineError.status,
			requestId: clineError.requestId,
			errorType: event.errorType,
			failurePhase: event.failurePhase,
			// Every event here is a failure the user actually saw: transient
			// errors are retried inside the provider layer before any event
			// reaches this adapter, and recoverable in-run notices are filtered
			// out upstream. The legacy extension applies the same
			// surfaced-failures-only rule at its emission sites, so the A/B
			// cohorts compare directly with no query-side filtering.
		})
	}

	private emitClineAuthErrorWithTelemetry(task?: string, sessionId?: string, provenance?: ComposerProvenance): void {
		this.emitClineAuthError(task, provenance)
		this.captureProviderFailure({
			sessionId: sessionId ?? this.task?.taskId,
			error: CLINE_ACCOUNT_AUTH_ERROR_MESSAGE,
			providerId: this.getActiveProviderId(),
			errorType: PROVIDER_FAILURE_ERROR_TYPE.AUTH,
			failurePhase: PROVIDER_FAILURE_PHASE.PREFLIGHT,
		})
	}

	/**
	 * Emit a proper auth error for the 'cline' provider when the user is not
	 * logged in. The message sequence drives ErrorRow to render the
	 * "Sign in to Cline" button.
	 *
	 * Message sequence:
	 *   1. say:'task'           – the user's message text
	 *   2. say:'api_req_started' – opens the API request row
	 *   3. ask:'api_req_failed'  – ClineError JSON → ErrorRow renders auth UI
	 */
	private emitClineAuthError(task?: string, provenance?: ComposerProvenance): void {
		const ts = Date.now()
		const hasConversation = this.task !== undefined
		if (!this.task) {
			this.task = createTaskProxy(
				`auth-error-${ts}`,
				(text?: string, images?: string[], files?: string[], decisionId?: string, provenance?: ComposerProvenance) =>
					this.askResponse(text, images, files, decisionId, provenance),
				() => this.cancelTask(),
			)
		}
		this.pendingClineAuthRetry =
			task === undefined ? undefined : { task: this.task, prompt: task, provenance, hasConversation }

		const clineError = new ClineError(
			{ message: CLINE_ACCOUNT_AUTH_ERROR_MESSAGE, status: 401 },
			undefined, // modelId
			"cline",
		)
		const serializedError = clineError.serialize()

		const failedAskTs = ts + 2
		const messages: ClineMessage[] = [
			{
				ts,
				type: "say",
				say: "task",
				text: task ?? "",
				partial: false,
			},
			{
				ts: ts + 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					streamingFailedMessage: serializedError,
				} satisfies ClineApiReqInfo),
				partial: false,
			},
			{
				ts: failedAskTs,
				type: "ask",
				ask: "api_req_failed",
				text: serializedError,
				partial: false,
			},
		]

		this.turnStateTracker.set("error", failedAskTs)

		this.messages.appendAndEmit(messages, {
			type: "status",
			payload: {
				sessionId: this.sessions.getActiveSession()?.sessionId ?? "",
				status: "error",
			},
		})

		this.postStateToWebview().catch(() => {})
	}

	/**
	 * Check if an error message indicates an insufficient credits / balance error
	 * by reshaping it into ClineError format and inspecting the result.
	 */
	private isClineBalanceError(errorMessage: string): boolean {
		try {
			const shaped = JSON.parse(reshapeErrorForWebview({ message: errorMessage }))
			return shaped.code === "insufficient_credits"
		} catch {
			return false
		}
	}

	/**
	 * Emit a balance error for the 'cline' provider when the user has insufficient
	 * credits. Produces the same message sequence as emitClineAuthError so the
	 * webview renders the "Buy Credits" button via CreditLimitError.
	 *
	 * Message sequence:
	 *   1. say:'api_req_started' – streamingFailedMessage holds the ClineError JSON
	 *   2. ask:'api_req_failed'  – ClineError JSON → ErrorRow renders balance UI
	 */
	private emitClineBalanceError(rawErrorMessage: string): void {
		const ts = Date.now()

		// reshapeErrorForWebview extracts structured fields from the SDK error
		// message (which may be plain text or embedded JSON) and produces the
		// ClineError-serialized JSON that the webview's ErrorRow expects.
		const serializedError = reshapeErrorForWebview({
			message: rawErrorMessage,
		})

		const failedAskTs = ts + 1
		const messages: ClineMessage[] = [
			{
				ts,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					streamingFailedMessage: serializedError,
				} satisfies ClineApiReqInfo),
				partial: false,
			},
			{
				ts: failedAskTs,
				type: "ask",
				ask: "api_req_failed",
				text: serializedError,
				partial: false,
			},
		]

		this.turnStateTracker.set("error", failedAskTs)

		this.messages.appendAndEmit(messages, {
			type: "status",
			payload: {
				sessionId: this.sessions.getActiveSession()?.sessionId ?? "",
				status: "error",
			},
		})

		this.postStateToWebview().catch(() => {})
	}

	/** Shared with the walkthrough and checkpoints; patches stay relative to each module. */
	async getThreadWorktreeDiffs(threadId: string) {
		return this.threadWorktrees.exclusive(() => this.threadWorktrees.diffs(threadId))
	}

	async threadWorktreeAction(request: ThreadWorktreeActionRequest): Promise<WorktreeActionResult> {
		const workspace = await this.getWorkspaceRoot()
		const data = request.json ? JSON.parse(request.json) : {}
		const id = request.threadId
		const running = this.sessions.getSession(id)?.isRunning
		const workspaceOff = !!this.stateManager.getWorkspaceStateKey("worktreeToggles")?.disabled
		switch (request.action) {
			case "state": {
				const history = await this.taskHistory.listHistory({ hydrate: false })
				return {
					state: {
						settings: await this.threadWorktrees.settings(),
						availability: await this.threadWorktrees.availability(workspace, workspaceOff),
						mapping: id ? await this.threadWorktrees.get(id) : undefined,
						settled: (
							await this.threadWorktrees.settled(
								history.map(sessionHistoryRecordToHistoryItem),
								history.filter((item) => item.status === "completed").map((item) => item.sessionId),
							)
						).filter((m) => m.workspace === workspace && !this.sessions.getSession(m.threadId)?.isRunning),
					},
				}
			}
			case "configure":
				await this.threadWorktrees.configure(data as ThreadWorktreeSettings)
				return {}
			case "workspaceOff":
				this.stateManager.setWorkspaceState("worktreeToggles", { disabled: !!data.disabled })
				await this.stateManager.flushPendingState()
				return {}
			case "diffs":
				return { diffs: await this.threadWorktrees.diffs(id) }
			case "open": {
				const mapping = await this.threadWorktrees.get(id)
				if (!mapping) throw new Error("This thread has no worktree")
				const opened = await HostProvider.workspace.openFolder({ path: mapping.cwd, newWindow: true })
				if (!opened.success) throw new Error("Could not open the worktree window")
				return {}
			}
			case "bring":
				if (running) return { warning: "Wait for the thread to finish before bringing changes here." }
				return this.threadWorktrees.bring(id)
			case "undo":
				return this.threadWorktrees.undo(id)
			case "takeOver":
				if (running) return { warning: "Stop this thread before taking over its branch." }
				return this.threadWorktrees.takeOver(id)
			case "remove": {
				if (running) return { warning: "Stop this thread before removing its worktree." }
				const release = this.sessions.beginTaskDeletion(id)
				try {
					await this.sessions.removeSession(id)
					return await this.threadWorktrees.remove(id, request.confirmed)
				} finally {
					release()
				}
			}
			default:
				throw new Error("Unknown worktree action")
		}
	}

	// ---- Task lifecycle ----

	async initTask(
		prompt?: string,
		images?: string[],
		files?: string[],
		historyItem?: HistoryItem,
		taskSettings?: Partial<Settings>,
		options?: { background?: boolean; taskGroupId?: string; runInWorktree?: boolean; provenance?: ComposerProvenance },
	): Promise<string | undefined> {
		await this.waitForInitialRemoteConfig()
		// A stale pill pick (group deleted between selection and send) starts unfiled.
		if (options?.taskGroupId && !(await this.taskGroupStore.getGroup(options.taskGroupId))) {
			Logger.warn(`[SdkController] initTask: unknown taskGroupId ${options.taskGroupId}, starting unfiled`)
			options = { ...options, taskGroupId: undefined }
		}
		// A new task is starting — the agent is about to stream.
		const taskId = await (options
			? this.taskStart.initTask(prompt, images, files, historyItem, taskSettings, options)
			: this.taskStart.initTask(prompt, images, files, historyItem, taskSettings))
		if (taskId && extractTicketTags(prompt).length) await this.autoTagThread(taskId, prompt)
		// Thread titles run once per new thread (never for resumed ones) when
		// the feature is enabled; failures are logged inside and never block.
		if (taskId && !historyItem && prompt?.trim()) {
			// Captured now, from what the new thread actually started with
			// (composer profile/effort overrides and mode included).
			const context = this.taskSessions?.get(taskId)
			const globalMode = this.stateManager?.getGlobalSettingsKey("mode") === "plan" ? "plan" : "act"
			void this.generateThreadTitle(taskId, prompt, {
				mode: context?.mode ?? globalMode,
				selection: context?.apiSelection ? structuredClone(context.apiSelection) : undefined,
			})
		}
		return taskId
	}

	private async generateThreadTitle(taskId: string, prompt: string, thread: ThreadTitleSource): Promise<void> {
		await maybeGenerateThreadTitle(
			{
				store: this.stateManager,
				getTitleState: (id) => this.taskHistory.getThreadTitleState(id),
				applyTitle: async (id, title) => {
					const written = await this.taskHistory.applyGeneratedThreadTitle(id, title)
					if (written) await this.postStateToWebview()
					return written
				},
			},
			taskId,
			prompt,
			thread,
		)
	}

	/** Tags the thread with ticket keys/URLs found in a user message (regex only). Best-effort. */
	private async autoTagThread(taskId: string, text: string | undefined): Promise<void> {
		try {
			if (await this.taskHistory.addAutoTicketTags(taskId, text)) await this.postStateToWebview()
		} catch (error) {
			Logger.warn(`[SdkController] Failed to auto-tag thread ${taskId}:`, error)
		}
	}

	async reinitExistingTaskFromId(taskId: string): Promise<void> {
		await this.waitForInitialRemoteConfig()
		await this.taskStart.reinitExistingTaskFromId(taskId)
	}

	async cancelTask(): Promise<void> {
		const child = this.subagentThreads?.get(this.task?.taskId ?? "")
		if (child?.parentTaskId) {
			await this.stopSubagent(child.runtimeOwnerTaskId ?? child.parentTaskId, child.id)
			return
		}
		// Fence first: mark resumable before aborting so any straggler events from the aborted
		// turn land on the wrong side of the UI mode. (Full fence-before-abort epoch bump lands
		// in S6; this sets the authoritative phase now.)
		this.turnStateTracker.set("resumable")
		await this.taskControl.cancelTask()
	}

	async cancelBackgroundCommand(): Promise<void> {
		stubWarn("cancelBackgroundCommand")
	}

	/**
	 * "Proceed While Running": detach every in-flight foreground terminal
	 * command. Each pending run_commands call returns its partial output plus
	 * the log file path the remaining output is redirected to, and the agent
	 * turn continues while the commands keep running in their terminals.
	 */
	async proceedWhileRunningCommand(): Promise<void> {
		const detached = this.foregroundCommands.proceedWhileRunning()
		if (detached === 0) {
			Logger.warn("[SdkController] proceedWhileRunningCommand: No foreground command is running")
		}
	}

	async cancelQueuedPrompt(promptId: string): Promise<void> {
		const trimmedPromptId = promptId.trim()
		if (!trimmedPromptId) {
			Logger.warn("[SdkController] cancelQueuedPrompt: Missing prompt id")
			return
		}

		const activeSession = this.sessions.getActiveSession()
		if (!activeSession) {
			Logger.warn("[SdkController] cancelQueuedPrompt: No active session")
			return
		}

		const result = await activeSession.sdkHost.pendingPrompts("delete", {
			sessionId: activeSession.sessionId,
			promptId: trimmedPromptId,
		})
		if (!result.removed) {
			Logger.warn(`[SdkController] cancelQueuedPrompt: Prompt not found: ${trimmedPromptId}`)
		}
		await this.postStateToWebview()
	}

	/**
	 * Manually compact (condense) the active task's conversation. Triggered by
	 * the compact button and the `/compact` (alias `/smol`) slash command.
	 * Mirrors the CLI's `/compact` local command: runs an SDK manual compaction
	 * and persists the compaction sidecar so the model's working context is
	 * reduced on the next turn and later resumes.
	 */
	async compactTask(): Promise<void> {
		if (this.subagentThreads?.has(this.task?.taskId ?? "")) throw new Error("Subagent threads are read-only.")
		await this.compaction.compactTask()
	}

	async clearTask(): Promise<void> {
		this.pendingClineAuthRetry = undefined
		// No active task — UI returns to idle (input enabled, no buttons/thinking).
		await this.taskControl.clearTask()
		this.turnStateTracker.set("idle")
		await this.postStateToWebview()
	}

	async handleTaskCreation(prompt: string): Promise<void> {
		await this.initTask(prompt)
	}

	getPendingDecisionId(responseType: "messageResponse" | "yesButtonClicked" | "noButtonClicked"): string | undefined {
		const child = this.subagentThreads?.get(this.task?.taskId ?? "")
		const decision = child
			? this.taskSessions
					.get(child.runtimeOwnerTaskId ?? child.parentTaskId ?? "")
					?.interactions.getPendingDecision(child.agentId ?? "")
			: this.interactions?.getPendingDecision()
		return decision?.kind === (responseType === "messageResponse" ? "question" : "approval") ? decision.id : undefined
	}

	/**
	 * Send a follow-up message to the active session.
	 * This is the "askResponse" equivalent — continues the conversation.
	 *
	 * Like initTask(), this is fire-and-forget: core.send() blocks until
	 * the agent turn completes, but events stream in real-time via the
	 * subscription. We do NOT await the send — the gRPC handler needs to
	 * return immediately so the webview stays responsive.
	 */
	async askResponse(
		prompt?: string,
		images?: string[],
		files?: string[],
		decisionId?: string,
		provenance?: ComposerProvenance,
	): Promise<void> {
		const decisionResponseType = this.task?.taskState?.askResponse
		const child = this.subagentThreads?.get(this.task?.taskId ?? "")
		const ownerId = child ? (child.runtimeOwnerTaskId ?? child.parentTaskId) : this.task?.taskId
		const ownerInteractions = ownerId ? this.taskSessions?.get(ownerId)?.interactions : undefined
		const childDecision = ownerInteractions?.getPendingDecisions?.().find((pending) => {
			if (decisionId ? pending.id !== decisionId : pending.id !== ownerInteractions.getPendingDecision()?.id) return false
			return Array.from(this.subagentThreads?.values() ?? []).some(
				(item) =>
					(item.runtimeOwnerTaskId ?? item.parentTaskId) === ownerId &&
					item.agentId === pending.agentId &&
					(!child || item.id === child.id || item.parentTaskId === child.id),
			)
		})
		if (
			childDecision &&
			(childDecision.kind === "question"
				? decisionResponseType === "messageResponse"
				: decisionResponseType === "yesButtonClicked" || decisionResponseType === "noButtonClicked")
		) {
			const responseType = decisionResponseType
			if (
				childDecision.kind === "approval" &&
				(responseType === "yesButtonClicked" || responseType === "noButtonClicked")
			) {
				ownerInteractions!.resolvePendingToolApproval(prompt, responseType, images, files, childDecision.id)
			} else if (childDecision.kind === "question" && responseType === "messageResponse") {
				ownerInteractions!.resolvePendingAskQuestion(prompt, childDecision.id)
			}
			await this.postStateToWebview()
			return
		}
		if (child) {
			const parent = this.taskSessions.get(child.runtimeOwnerTaskId ?? child.parentTaskId ?? "")
			const decision = parent?.interactions.getPendingDecision(child.agentId ?? "")
			const responseType = decisionResponseType
			if (decisionId && decision?.id !== decisionId) return
			if (decision?.kind === "approval" && (responseType === "yesButtonClicked" || responseType === "noButtonClicked")) {
				parent!.interactions.resolvePendingToolApproval(prompt, responseType, images, files, decision.id)
			} else if (decision?.kind === "question" && responseType === "messageResponse") {
				parent!.interactions.resolvePendingAskQuestion(prompt, decision.id)
			} else throw new Error("Subagent threads are read-only. Quote into the parent to continue.")
			await this.postStateToWebview()
			return
		}
		if (decisionId && !this.interactions.hasPendingDecision(decisionId)) return
		if (!decisionId) {
			// Capture the projected decision before awaiting metadata writes. A legacy
			// response must not answer a later decision that replaces it while we wait.
			const decision = this.interactions?.getPendingDecision?.()
			const responseType = decisionResponseType
			if (
				decision &&
				(decision.kind === "question" || responseType === "yesButtonClicked" || responseType === "noButtonClicked")
			)
				decisionId = decision.id
		}
		this.sessions.assertTaskAvailable(this.task?.taskId)
		// The sign-in retry answers only the next response to the task that
		// showed the error; a task opened since then does not inherit it.
		const retry = this.pendingClineAuthRetry
		this.pendingClineAuthRetry = undefined
		if (retry && retry.task === this.task) {
			const askResponse = decisionResponseType
			if (askResponse === "yesButtonClicked") {
				await this.initTask(retry.prompt, images, files, undefined, undefined, { provenance: retry.provenance })
				return
			}
			// A task that failed before it had a session has nothing to
			// continue, so a prompt typed in the composer starts it again. With
			// attachments but no text, the original prompt is kept.
			if (askResponse === "messageResponse" && !retry.hasConversation) {
				await (prompt?.trim()
					? this.initTask(prompt, images, files, undefined, undefined, { provenance })
					: this.initTask(retry.prompt, images, files, undefined, undefined, { provenance: retry.provenance }))
				return
			}
		}

		const submittedTaskId = this.task?.taskId
		if (submittedTaskId) await this.taskHistory.markTaskActive(submittedTaskId)
		if (submittedTaskId && extractTicketTags(prompt).length) await this.autoTagThread(submittedTaskId, prompt)
		this.sessions.assertTaskAvailable(submittedTaskId)
		if (this.task?.taskId !== submittedTaskId || (decisionId && !this.interactions.hasPendingDecision(decisionId))) return
		const turnStateBefore = this.turnStateTracker.get()

		// Answering an ask / continuing after completion / resuming a cancelled task all kick off a
		// new agent turn — move the authoritative phase to "streaming" so the footer shows
		// Thinking + Cancel (and not the stale resumable/completed/awaiting_followup buttons or the
		// scroll-arrow default). Mirrors initTask(). The webview gates turnState by seq, and the
		// session-event coordinator will set the terminal phase (completed/awaiting_followup/error)
		// when this turn ends.
		this.turnStateTracker.set("streaming")
		// Clear the previous turn's completion signal so this new turn's phase is computed fresh.
		this.messageTranslatorState.clearTurnOutcome()
		// The webview only learns the phase through a full state post. Without one here it would
		// keep the stale terminal phase (and hide the thinking indicator) until the first session
		// event of the new turn posts state — a visible delay after every follow-up/approval.
		this.postStateToWebview().catch((error) => {
			Logger.error("[SdkController] Failed to post state after askResponse phase change:", error)
		})
		await this.followups.askResponse(
			prompt,
			images,
			files,
			decisionResponseType,
			turnStateBefore.phase,
			undefined,
			decisionId,
			provenance,
		)
	}

	async editMessageAndRegenerate(input: {
		messageTs: number
		text: string
		images?: string[]
		files?: string[]
		restoreWorkspace?: boolean
		provenance?: ComposerProvenance
	}): Promise<void> {
		if (this.subagentThreads?.has(this.task?.taskId ?? "")) throw new Error("Subagent threads are read-only.")
		const editedText = input.text.trim()
		if (!editedText && (input.images?.length ?? 0) === 0 && (input.files?.length ?? 0) === 0) {
			throw new Error("Edited message cannot be empty")
		}

		const activeSession = this.sessions.getActiveSession()
		const currentTask = this.task
		if (!currentTask) {
			throw new Error("No active task to edit")
		}

		const clineMessages = currentTask.messageStateHandler.getClineMessages()
		const targetIndex = clineMessages.findIndex((message) => message.ts === input.messageTs)
		if (targetIndex === -1) {
			throw new Error("Message to edit was not found")
		}
		const targetMessage = clineMessages[targetIndex]
		if (targetMessage.type !== "say" || (targetMessage.say !== "task" && targetMessage.say !== "user_feedback")) {
			throw new Error("Only user messages can be edited")
		}

		const userOrdinal = clineMessages.slice(0, targetIndex + 1).filter(isVisibleCheckpointUserMessage).length
		const canRestoreWorkspace = getCheckpointRunCountForMessage(clineMessages, targetIndex) !== undefined
		const sourceSessionId = activeSession?.sessionId ?? currentTask.taskId
		let sdkMessages: SdkUserMessage[]
		let tempHost: VscodeSessionHost | undefined
		const sessionHost = activeSession?.sdkHost ?? (tempHost = await this.createRemoteConfigAwareSessionHost())
		try {
			sdkMessages = (await readCurrentMessages(sessionHost, sourceSessionId)) as SdkUserMessage[]
			const sdkTargetIndex = findSdkUserMessageIndexByOrdinal(sdkMessages, userOrdinal)
			if (sdkTargetIndex === -1) {
				throw new Error("Could not map edited message to the conversation history")
			}
			const checkpointRunCount = getSdkCheckpointRunCountForMessageIndex(sdkMessages, sdkTargetIndex)

			const initialMessages = sdkMessages.slice(0, sdkTargetIndex) as Parameters<
				VscodeSessionHost["start"]
			>[0]["initialMessages"]
			const firstUserMessage = sdkMessages.find(
				(message) => message.role === "user" && !!extractSdkUserText(message) && !isSyntheticSdkUserMessage(message),
			)
			const historyTitle =
				userOrdinal === 1
					? editedText
					: extractSdkUserText(firstUserMessage ?? {}) || clineMessages[0]?.text || editedText
			const fallbackCwd = await this.getWorkspaceRoot()
			const [sessionRecord, historyItem] = await Promise.all([
				sessionHost.get(sourceSessionId).catch(() => undefined),
				this.taskHistory.findHistoryItem(currentTask.taskId).catch(() => undefined),
			])
			const workspaceCheckpoint =
				checkpointRunCount === undefined
					? undefined
					: findCheckpointForRun(readSessionCheckpointHistory(sessionRecord), checkpointRunCount)
			if (input.restoreWorkspace && !workspaceCheckpoint) {
				throw new Error("No workspace checkpoint is available for this message")
			}
			const cwd =
				sessionRecord?.cwd?.trim() ||
				sessionRecord?.workspaceRoot?.trim() ||
				historyItem?.cwdOnTaskInitialization?.trim() ||
				fallbackCwd
			const mode =
				activeSession?.startConfig?.mode ??
				this.taskSessions?.get(currentTask.taskId)?.mode ??
				(this.stateManager.getGlobalSettingsKey("mode") === "plan" ? "plan" : "act")
			const apiSelection =
				this.taskSessions?.get(currentTask.taskId)?.pendingApiSelection ??
				this.taskSessions?.get(currentTask.taskId)?.apiSelection ??
				activeSession?.apiSnapshot?.selection ??
				historyItem?.apiSelection
			const config = await this.sessionConfigBuilder.build({
				cwd,
				mode,
				prompt: historyTitle,
				...(apiSelection ? { apiSelection } : {}),
				...(activeSession?.apiSnapshot && !this.taskSessions?.get(currentTask.taskId)?.pendingApiSelection
					? { apiConfiguration: activeSession.apiSnapshot.configuration }
					: {}),
			})
			if (usesClineAccountAuth(config.providerId) && !config.apiKey) {
				this.emitClineAuthErrorWithTelemetry(editedText)
				return
			}

			const resolvedPrompt = await this.resolveContextMentions(editedText, undefined, input.provenance)
			const startInput = {
				...buildStartSessionInput(config, { prompt: historyTitle, cwd, mode }),
				initialMessages,
				sessionMetadata: {
					apiSelection: getSessionApiSnapshot(config)?.selection,
					title: historyTitle,
					modelId: config.modelId,
					...threadIdentityMetadata(historyItem),
					...(checkpointRunCount
						? { checkpoint: createRestoredCheckpointMetadata(sessionRecord, checkpointRunCount) }
						: {}),
				},
			}

			if (input.restoreWorkspace) {
				if (activeSession?.isRunning) {
					throw new Error("Wait for the current run to finish before restoring workspace changes")
				}
				if (!canRestoreWorkspace || checkpointRunCount === undefined) {
					throw new Error("Workspace restore is only available for messages that started an agent run")
				}
				await sessionHost.restore({
					sessionId: sourceSessionId,
					checkpointRunCount,
					cwd,
					restore: {
						messages: false,
						workspace: true,
						omitCheckpointMessageFromSession: true,
					},
				})
			}

			// The edit supersedes the old session — settle any pending tool
			// approval / ask_question exactly like cancelTask does. Without this,
			// the old run stays suspended forever on a promise nothing can
			// resolve, and the stale parked resolver intercepts later responses.
			this.interactions.clearPending("Superseded by an edited message")

			const { startResult, sdkHost } = await this.sessions.startNewSession(startInput)

			this.turnStateTracker.set("streaming")
			this.messageTranslatorState.clearTurnOutcome()
			this.resetMessageTranslatorAndFence()

			const task = createTaskProxy(
				startResult.sessionId,
				(text?: string, images?: string[], files?: string[], decisionId?: string, provenance?: ComposerProvenance) =>
					this.askResponse(text, images, files, decisionId, provenance),
				() => this.cancelTask(),
			)
			this.task = task

			const newHistoryItem = {
				...createHistoryItemFromSession(startResult.sessionId, historyTitle, config.modelId, cwd),
				apiSelection: getSessionApiSnapshot(config)?.selection,
			}
			await this.taskHistory.updateTaskHistoryItem(newHistoryItem)

			const visibleMessages = clineMessages.slice(0, targetIndex)
			if (visibleMessages.length > 0) {
				task.messageStateHandler.addMessages(visibleMessages)
			}
			task.messageStateHandler.addMessages([
				{
					ts: Date.now(),
					type: "say",
					say: userOrdinal === 1 ? "task" : "user_feedback",
					text: editedText,
					images: input.images,
					files: input.files,
					partial: false,
				},
			])
			await this.postStateToWebview()

			this.sessions.fireAndForgetSend(sdkHost, startResult.sessionId, resolvedPrompt, input.images, input.files)
		} finally {
			await tempHost?.dispose("editMessageAndRegenerate")
		}
	}

	async restoreCheckpoint(input: { checkpointRunCount: number; restoreType: ClineCheckpointRestore }): Promise<void> {
		if (this.subagentThreads?.has(this.task?.taskId ?? "")) throw new Error("Subagent threads are read-only.")
		const restoreMessages = input.restoreType === "task" || input.restoreType === "taskAndWorkspace"
		const restoreWorkspace = input.restoreType === "workspace" || input.restoreType === "taskAndWorkspace"
		const checkpointRunCount = Number(input.checkpointRunCount)
		if (!Number.isInteger(checkpointRunCount) || checkpointRunCount < 1) {
			throw new Error("checkpointRunCount must be a positive integer")
		}

		const activeSession = this.sessions.getActiveSession()
		const currentTask = this.task
		if (!activeSession || !currentTask) {
			throw new Error("No active task to restore")
		}
		if (activeSession.isRunning) {
			await this.cancelTask()
		}

		const currentMessages = currentTask.messageStateHandler.getClineMessages()
		const target = restoreMessages ? findVisibleCheckpointUserMessageByRun(currentMessages, checkpointRunCount) : undefined
		if (restoreMessages && !target) {
			throw new Error(`Could not find user message for checkpoint run ${checkpointRunCount}`)
		}

		const cwd = await this.getWorkspaceRoot()
		const mode =
			activeSession?.startConfig?.mode ??
			this.taskSessions?.get(currentTask.taskId)?.mode ??
			(this.stateManager.getGlobalSettingsKey("mode") === "plan" ? "plan" : "act")
		const firstUserMessage = currentMessages.find(isVisibleCheckpointUserMessage)
		const restoredText = target?.message.text ?? ""
		const historyTitle = checkpointRunCount === 1 ? restoredText : firstUserMessage?.text || restoredText
		const apiSelection =
			this.taskSessions?.get(currentTask.taskId)?.pendingApiSelection ??
			this.taskSessions?.get(currentTask.taskId)?.apiSelection ??
			activeSession.apiSnapshot?.selection
		const config = restoreMessages
			? await this.sessionConfigBuilder.build({
					cwd,
					mode,
					prompt: historyTitle,
					...(apiSelection ? { apiSelection } : {}),
					...(activeSession.apiSnapshot && !this.taskSessions?.get(currentTask.taskId)?.pendingApiSelection
						? { apiConfiguration: activeSession.apiSnapshot.configuration }
						: {}),
				})
			: undefined
		if (config && usesClineAccountAuth(config.providerId) && !config.apiKey) {
			this.emitClineAuthErrorWithTelemetry(restoredText)
			return
		}

		const historyItem = config ? await this.taskHistory.findHistoryItem(currentTask.taskId).catch(() => undefined) : undefined
		const startInput = config
			? {
					...buildStartSessionInput(config, { prompt: historyTitle, cwd, mode }),
					sessionMetadata: {
						apiSelection: getSessionApiSnapshot(config)?.selection,
						title: historyTitle,
						modelId: config.modelId,
						...threadIdentityMetadata(historyItem),
					},
				}
			: undefined

		const restored = await this.sessions.restoreActiveSession({
			sessionId: activeSession.sessionId,
			checkpointRunCount,
			cwd,
			restore: {
				messages: restoreMessages,
				workspace: restoreWorkspace,
				omitCheckpointMessageFromSession: true,
			},
			...(startInput ? { start: startInput } : {}),
		})

		if (!restoreMessages) {
			await this.postStateToWebview()
			return
		}

		if (!restored.sessionId || !restored.startResult || !target) {
			throw new Error("Checkpoint restore did not return a new session")
		}

		this.turnStateTracker.set("idle")
		this.messageTranslatorState.clearTurnOutcome()
		this.resetMessageTranslatorAndFence()

		const task = createTaskProxy(
			restored.sessionId,
			(text?: string, images?: string[], files?: string[], decisionId?: string, provenance?: ComposerProvenance) =>
				this.askResponse(text, images, files, decisionId, provenance),
			() => this.cancelTask(),
		)
		this.task = task

		const newHistoryItem = {
			...createHistoryItemFromSession(restored.sessionId, historyTitle, config?.modelId ?? "", cwd),
			apiSelection: getSessionApiSnapshot(config)?.selection,
		}
		await this.taskHistory.updateTaskHistoryItem(newHistoryItem)

		const visibleMessages = currentMessages.slice(0, target.index)
		if (visibleMessages.length > 0) {
			this.messages.replaceMessages(visibleMessages)
		}

		this.checkpointRestoreInput = {
			text: restoredText,
			images: target.message.images ?? [],
			files: target.message.files ?? [],
			sessionId: restored.sessionId,
		}
		await this.postStateToWebview()
	}

	async getWalkthroughCollectionInput(taskId: string, scope: WalkthroughScope): Promise<CollectionInput> {
		if (this.task?.taskId !== taskId) throw new Error("Open the requested thread first")
		let temporaryHost: VscodeSessionHost | undefined
		const host =
			this.sessions.getSession(taskId)?.sdkHost ?? (temporaryHost = await this.createRemoteConfigAwareSessionHost())
		try {
			const [session, messages, workspace, edits, worktree] = await Promise.all([
				host.get(taskId),
				readCurrentMessages(host, taskId),
				HostProvider.workspace.getWorkspacePaths({}),
				ensureTaskDirectoryExists(taskId).then(readEdits),
				this.threadWorktrees.get(taskId),
			])
			const cwd = session?.cwd || session?.workspaceRoot || (await this.getWorkspaceRoot())
			// An isolated thread's changes live only in its worktree (one per module with mm), not
			// in the user's own workspace folders.
			const rootPaths = worktree ? worktree.modules.map((module) => module.path) : workspace.paths
			return {
				taskId,
				scope,
				messages,
				runSpans: messages.map(getUserRunSpan),
				edits,
				roots: [...new Set([cwd, ...rootPaths])],
				checkpointRoot: cwd,
				checkpoints: readSessionCheckpointHistory(session),
			}
		} finally {
			await temporaryHost?.dispose("walkthroughCollection")
		}
	}

	/**
	 * Diffs the latest checkpoint — snapshotted when the user's last message
	 * started a run — against the current working tree. Returns undefined when
	 * no checkpoint exists (e.g. the workspace is not a git repository).
	 * Throws when there is no task at all.
	 */
	private async computeLatestCheckpointChanges(): Promise<CompareCheckpointResult["diffs"] | undefined> {
		const activeSession = this.sessions.getActiveSession()
		const sessionId = activeSession?.sessionId ?? this.task?.taskId
		if (!sessionId) {
			throw new Error("No active task to show changes for")
		}
		// After a window reload the latest task is shown from history without a
		// live session, so fall back to a temporary host for the comparison.
		let tempHost: VscodeSessionHost | undefined
		const sessionHost = activeSession?.sdkHost ?? (tempHost = await this.createRemoteConfigAwareSessionHost())
		try {
			if (!sessionHost.compareCheckpoint) {
				throw new Error("This session host does not support checkpoint comparison")
			}

			const sessionRecord = await sessionHost.get(sessionId)
			const latestCheckpoint = readSessionCheckpointHistory(sessionRecord).reduce(
				(latest, entry) => (!latest || entry.runCount > latest.runCount ? entry : latest),
				undefined as ReturnType<typeof readSessionCheckpointHistory>[number] | undefined,
			)
			if (!latestCheckpoint) {
				return undefined
			}

			const cwd = sessionRecord?.cwd?.trim() || sessionRecord?.workspaceRoot?.trim() || (await this.getWorkspaceRoot())
			const { diffs } = await sessionHost.compareCheckpoint({
				sessionId,
				checkpointRunCount: latestCheckpoint.runCount,
				cwd,
			})
			return diffs
		} finally {
			await tempHost?.dispose("viewLatestCheckpointChanges")
		}
	}

	/**
	 * Whether Reset Code can restore the workspace from the user message with
	 * the given ts. Answered when the user opens the message for editing, so
	 * the checkpoint written for the latest turn is visible. The message is
	 * mapped to its run the same way editMessageAndRegenerate maps it, so a
	 * positive answer means that edit will find the checkpoint too.
	 *
	 * After a window reload the latest task is shown from history without a
	 * live session; then, as in editMessageAndRegenerate, a temporary host is
	 * created for the read and disposed afterwards.
	 */
	async hasWorkspaceCheckpointForMessage(messageTs: number): Promise<boolean> {
		const activeSession = this.sessions.getActiveSession()
		const currentTask = this.task
		if (!currentTask) {
			return false
		}
		const clineMessages = currentTask.messageStateHandler.getClineMessages()
		const targetIndex = clineMessages.findIndex((message) => message.ts === messageTs)
		if (targetIndex === -1 || getCheckpointRunCountForMessage(clineMessages, targetIndex) === undefined) {
			return false
		}
		const userOrdinal = clineMessages.slice(0, targetIndex + 1).filter(isVisibleCheckpointUserMessage).length
		const sessionId = activeSession?.sessionId ?? currentTask.taskId
		let tempHost: VscodeSessionHost | undefined
		try {
			const sessionHost = activeSession?.sdkHost ?? (tempHost = await this.createRemoteConfigAwareSessionHost())
			const [sessionRecord, sdkMessages] = await Promise.all([
				sessionHost.get(sessionId),
				readCurrentMessages(sessionHost, sessionId) as Promise<SdkUserMessage[]>,
			])
			const sdkIndex = findSdkUserMessageIndexByOrdinal(sdkMessages, userOrdinal)
			if (sdkIndex === -1) {
				return false
			}
			const runCount = getSdkCheckpointRunCountForMessageIndex(sdkMessages, sdkIndex)
			return (
				runCount !== undefined &&
				findCheckpointForRun(readSessionCheckpointHistory(sessionRecord), runCount) !== undefined
			)
		} catch (error) {
			Logger.debug(`[SdkController] Failed to resolve workspace checkpoint for message ${messageTs}: ${error}`)
			return false
		} finally {
			try {
				await tempHost?.dispose("workspaceCheckpointForMessage")
			} catch (error) {
				Logger.debug(`[SdkController] Failed to dispose workspace checkpoint host: ${error}`)
			}
		}
	}

	/**
	 * Gates the "View Changes" button on the completion row: the number of
	 * files changed since the latest checkpoint, or 0 when nothing can be
	 * compared (no task, no checkpoint, comparison failure).
	 */
	async getLatestCheckpointChangesCount(): Promise<number> {
		try {
			return (await this.computeLatestCheckpointChanges())?.length ?? 0
		} catch (error) {
			Logger.debug(`[SdkController] Failed to count latest checkpoint changes: ${error}`)
			return 0
		}
	}

	/**
	 * "View Changes" on the completion row: opens a multi-file diff of
	 * everything that changed between the latest checkpoint — snapshotted when
	 * the user's last message started this run — and the current working tree.
	 */
	async viewLatestCheckpointChanges(): Promise<void> {
		const diffs = await this.computeLatestCheckpointChanges()
		if (diffs === undefined) {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "No checkpoint was taken for this task. Checkpoints require the workspace to be a git repository.",
			})
			return
		}
		if (diffs.length === 0) {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "No file changes found since your last message.",
			})
			return
		}

		await HostProvider.diff.openMultiFileDiff({
			title: "Changes since your last message",
			diffs: diffs.map((diff) => ({
				filePath: diff.filePath,
				leftContent: diff.leftContent,
				rightContent: diff.rightContent,
			})),
		})
	}

	/**
	 * Focuses a retained live task, or loads a persisted task for viewing.
	 * Other sessions keep running with their own transcript and approvals.
	 * The coordinator allocates its selection generation before the history
	 * lookup, so a stalled lookup cannot replace a newer user selection.
	 */

	async showTaskWithId(taskId: string): Promise<TaskResponse> {
		this.sessions.assertTaskAvailable(taskId)
		const historyItem = await this.taskControl.showTaskWithId(taskId)
		if (!historyItem) {
			throw new Error(`Task not found in history: ${taskId}`)
		}
		const context = this.taskSessions.get(taskId)
		if (context && this.task?.taskId === taskId) {
			const pending = await Promise.all(
				(await this.notebookStore.listPending(taskId)).map((review) => this.notebookStore.reviewDiffs(review, taskId)),
			)
			if (this.task?.taskId === taskId) {
				const current = context.task.messageStateHandler.getClineMessages()
				context.messages.replaceMessages(
					restoreNotebookChanges(current, taskId, pending, () => context.translator.nextTs()),
				)
				await this.postStateToWebview()
			}
		}
		return historyItemToTaskResponse(historyItem)
	}

	// ---- Mode switching ----

	async togglePlanActMode(modeToSwitchTo: Mode, chatContent?: ChatContent): Promise<boolean> {
		if (this.subagentThreads?.has(this.task?.taskId ?? "")) throw new Error("Subagent threads are read-only.")
		const taskId = this.task?.taskId
		const hadLiveSession = taskId ? !!this.sessions.getSession(taskId) : false
		const result = await this.mode.togglePlanActMode(modeToSwitchTo, chatContent)
		// Live mode changes are committed by onModeRebuilt inside the transition
		// lock. A history-only task has no session to rebuild, so commit its mode
		// after the coordinator completes the global mode change.
		if (!hadLiveSession && taskId && this.task?.taskId === taskId) {
			const mode = this.sessions.getSession(taskId)?.startConfig?.mode ?? this.stateManager.getGlobalSettingsKey("mode")
			if (mode === "plan" || mode === "act") {
				this.getTaskSessionContext(taskId).mode = mode
				this.recordTaskApiSelection(taskId)
				await this.taskHistory.setTaskMode(taskId, mode)
			}
		}
		return result
	}

	// ---- Telemetry ----

	async updateTelemetrySetting(telemetrySetting: TelemetrySetting): Promise<void> {
		setTelemetryOptOutGlobally(telemetrySetting === "disabled", { telemetry: this.sdkTelemetry.telemetry })
		// Mirror to StateManager for existing VS Code services during the transition.
		this.stateManager.setGlobalState("telemetrySetting", telemetrySetting)
		await this.postStateToWebview()
	}

	// ---- Auth callbacks ----

	async handleSignOut(): Promise<void> {
		const sessionProviderId = this.getSessionProviderId() ?? this.getActiveProviderId()
		// Capture before deauth nulls the auth info, so the per-org config cache
		// (which can hold enterprise secrets) is actually deleted on sign-out.
		const organizationId = this.authService.getActiveOrganizationId() ?? undefined
		await this.taskControl.cancelClineTaskOnSignOut(isClineManagedProvider(sessionProviderId))
		await this.authService.handleDeauth(LogoutReason.USER_INITIATED)
		// Invalidate BEFORE clearing: a refresh that already fetched under the
		// signed-in identity must not republish the policy (and re-create the
		// secret-bearing caches) after the clear. The clear itself runs under the
		// same publication lock refreshes use, so it cannot interleave either.
		this.remoteConfigRefreshCoordinator.invalidate()
		await clearSdkRemoteConfig(this, {
			workspacePath: await this.getRemoteConfigWorkspacePath(),
			organizationId,
		})
		await this.postStateToWebview()
	}

	async handleOcaSignOut(): Promise<void> {
		await this.ocaAuthService.handleDeauth(LogoutReason.USER_INITIATED)
		await this.postStateToWebview()
	}

	async handleAuthCallback(customToken: string, provider: string | null = null): Promise<void> {
		await this.authService.handleAuthCallback(customToken, provider ?? "cline")
		// Fetch remote config immediately after login so enterprise policies
		// (provider lockdown, MCP servers, OTel, etc.) are applied right away.
		await this.refreshRemoteConfig()
		await this.postStateToWebview()
	}

	async handleOcaAuthCallback(code: string, state: string): Promise<void> {
		await this.ocaAuthService.handleAuthCallback(code, state)
		await this.postStateToWebview()
	}

	// ---- Provider auth callbacks ----

	private persistProviderApiKeyFromState(provider: string): void {
		const providerId = parseProviderId(provider)
		const apiKey = this.providerConfigStore.read(providerId).apiKey

		if (!apiKey) {
			Logger.warn(`[SdkController] No API key found after ${provider} auth callback`)
			return
		}

		this.providerConfigStore.write(providerId, { apiKey })
	}

	async handleOpenRouterCallback(code: string): Promise<void> {
		await this.authService.handleOpenRouterCallback(code)
		this.persistProviderApiKeyFromState("openrouter")
		await this.postStateToWebview()
	}

	async handleRequestyCallback(code: string): Promise<void> {
		await this.authService.handleRequestyCallback(code)
		this.persistProviderApiKeyFromState("requesty")
		await this.postStateToWebview()
	}

	async handleHicapCallback(code: string): Promise<void> {
		await this.authService.handleHicapCallback(code)
		this.persistProviderApiKeyFromState("hicap")
		await this.postStateToWebview()
	}

	async getTaskHistory(request: GetTaskHistoryRequest): Promise<TaskHistoryArray> {
		const { favoritesOnly, currentWorkspaceOnly, searchQuery, sortBy } = request
		const limit = request.limit > 0 ? Math.min(request.limit, 100) : 50
		const offset = request.offset > 0 ? request.offset : 0
		const workspacePath = currentWorkspaceOnly ? await this.getWorkspaceRoot() : undefined
		const sessionHistory = await this.taskHistory.listHistory({
			hydrate: false,
			limit: limit + 1,
			offset,
		})

		let filteredTasks = sessionHistory.filter((item) => {
			const ts = dateStringToTimestamp(item.updatedAt ?? item.endedAt ?? item.startedAt)
			const task = metadataString(item.metadata, "title") ?? item.prompt ?? ""

			if (!ts || !task) {
				return false
			}

			const isFavorited =
				metadataBoolean(item.metadata, "isFavorited") ?? metadataBoolean(item.metadata, "is_favorited") ?? false
			if (favoritesOnly && !isFavorited) {
				return false
			}

			if (currentWorkspaceOnly && workspacePath) {
				const sessionWorkspacePath = item.cwd ?? item.workspaceRoot
				if (!sessionWorkspacePath || !arePathsEqual(sessionWorkspacePath, workspacePath)) {
					return false
				}
			}

			return true
		})

		if (searchQuery) {
			const query = searchQuery.toLowerCase()
			filteredTasks = filteredTasks.filter((item) => {
				const task = metadataString(item.metadata, "title") ?? item.prompt ?? ""
				return task.toLowerCase().includes(query)
			})
		}

		filteredTasks.sort((a, b) => {
			switch (sortBy) {
				case "oldest":
					return sessionRecordActivityTs(a) - sessionRecordActivityTs(b)
				case "mostExpensive":
					return (metadataNumber(b.metadata, "totalCost") ?? 0) - (metadataNumber(a.metadata, "totalCost") ?? 0)
				case "mostTokens":
					return (
						(metadataNumber(b.metadata, "tokensIn") ?? 0) +
						(metadataNumber(b.metadata, "tokensOut") ?? 0) +
						(metadataNumber(b.metadata, "cacheWrites") ?? 0) +
						(metadataNumber(b.metadata, "cacheReads") ?? 0) -
						((metadataNumber(a.metadata, "tokensIn") ?? 0) +
							(metadataNumber(a.metadata, "tokensOut") ?? 0) +
							(metadataNumber(a.metadata, "cacheWrites") ?? 0) +
							(metadataNumber(a.metadata, "cacheReads") ?? 0))
					)
				default:
					return sessionRecordActivityTs(b) - sessionRecordActivityTs(a)
			}
		})

		const hasMore = sessionHistory.length > limit
		const pageItems = filteredTasks.slice(0, limit)
		// An aside lists under its parent's task; the parent may be on another page.
		const effectiveGroups = new Map<string, string | undefined>()
		for (const record of pageItems) {
			const item = sessionHistoryRecordToHistoryItem(record)
			if (item.parentTaskId && !item.isSubagent) {
				effectiveGroups.set(
					item.id,
					await resolveEffectiveTaskGroupId(item, (id) => this.taskHistory.findHistoryItem(id)),
				)
			}
		}
		const tasks = pageItems.map((item) => {
			const metadata = item.metadata
			return {
				id: item.sessionId,
				task: formatDisplayUserInput(metadataString(metadata, "title") ?? item.prompt ?? ""),
				ts: sessionRecordActivityTs(item),
				isFavorited: metadataBoolean(metadata, "isFavorited") ?? metadataBoolean(metadata, "is_favorited") ?? false,
				isSettled: metadataBoolean(metadata, "isSettled"),
				settledAt: metadataNumber(metadata, "settledAt") || undefined,
				parentTaskId: metadataString(metadata, "parentTaskId"),
				forkedAtTs: metadataNumber(metadata, "forkedAtTs") || undefined,
				size: metadataNumber(metadata, "size") ?? 0,
				totalCost: metadataNumber(metadata, "totalCost") ?? 0,
				tokensIn: metadataNumber(metadata, "tokensIn") ?? 0,
				tokensOut: metadataNumber(metadata, "tokensOut") ?? 0,
				cacheWrites: metadataNumber(metadata, "cacheWrites") ?? 0,
				cacheReads: metadataNumber(metadata, "cacheReads") ?? 0,
				modelId: item.model || metadataString(metadata, "modelId") || "",
				apiProvider: item.provider ?? "",
				title: metadataString(metadata, "threadTitle") ?? "",
				taskGroupId: effectiveGroups.has(item.sessionId)
					? (effectiveGroups.get(item.sessionId) ?? "")
					: (metadataString(metadata, "taskGroupId") ?? ""),
				isLegacy:
					metadataBoolean(metadata, "legacyTask") === true ||
					metadataBoolean(metadata, "migratedFromLegacyTask") === true,
			}
		})

		if (offset === 0 && !favoritesOnly && this.task?.taskId && !tasks.some((task) => task.id === this.task?.taskId)) {
			const taskMessage = this.task.messageStateHandler
				.getClineMessages()
				.find((message) => message.type === "say" && message.say === "task" && message.text)
			const matchesSearch = !searchQuery || taskMessage?.text?.toLowerCase().includes(searchQuery.toLowerCase())
			if (taskMessage?.text && matchesSearch) {
				tasks.unshift({
					id: this.task.taskId,
					task: formatDisplayUserInput(taskMessage.text),
					ts: taskMessage.ts || Date.now(),
					isFavorited: false,
					isSettled: undefined,
					settledAt: undefined,
					parentTaskId: undefined,
					forkedAtTs: undefined,
					size: 0,
					totalCost: 0,
					tokensIn: 0,
					tokensOut: 0,
					cacheWrites: 0,
					cacheReads: 0,
					modelId: this.task.api?.getModel?.().id ?? "",
					apiProvider: "",
					title: "",
					taskGroupId: (await this.taskHistory.findHistoryItem(this.task.taskId))?.taskGroupId ?? "",
					isLegacy: false,
				})
			}
		}

		return TaskHistoryArray.create({ tasks: tasks.slice(0, limit), hasMore })
	}

	async exportTaskWithId(id: string): Promise<void> {
		const taskDirPath = await this.taskHistory.getTaskDirPath(id)
		if (!taskDirPath) {
			throw new Error(`Task not found in history: ${id}`)
		}

		await fs.access(taskDirPath)
		Logger.log(`[EXPORT] Opening task directory: ${taskDirPath}`)
		const open = (await import("open")).default
		await open(taskDirPath)
	}

	async deleteTaskFromState(id: string): Promise<HistoryItem[]> {
		return this.taskHistory.deleteTaskFromState(id)
	}

	async deleteTasksFromState(ids: string[]): Promise<HistoryItem[]> {
		return this.taskHistory.deleteTasksFromState(ids)
	}

	async deleteAllTaskHistory(): Promise<DeleteAllTaskHistoryCount> {
		await this.clearTask()

		const taskHistory = await this.taskHistory.listHistory({ hydrate: false })
		const totalTasks = taskHistory.length

		const userChoice = (
			await HostProvider.window.showMessage(
				ShowMessageRequest.create({
					type: ShowMessageType.WARNING,
					message: "What would you like to delete?",
					options: {
						modal: true,
						items: ["Delete All Except Favorites", "Delete Everything"],
					},
				}),
			)
		).selectedOption

		if (userChoice === undefined) {
			return DeleteAllTaskHistoryCount.create({ tasksDeleted: 0 })
		}

		if (userChoice === "Delete All Except Favorites") {
			const hasFavoritedTasks = taskHistory.some(
				(task) =>
					metadataBoolean(task.metadata, "isFavorited") ?? metadataBoolean(task.metadata, "is_favorited") ?? false,
			)

			if (hasFavoritedTasks) {
				const tasksDeleted = await this.taskHistory.deleteAllTaskHistory({
					preserveFavorites: true,
				})
				await this.postStateToWebview()
				return DeleteAllTaskHistoryCount.create({ tasksDeleted })
			}

			const answer = (
				await HostProvider.window.showMessage({
					type: ShowMessageType.WARNING,
					message: "No favorited tasks found. Would you like to delete all tasks anyway?",
					options: {
						modal: true,
						items: ["Delete All Tasks"],
					},
				})
			).selectedOption

			if (answer === undefined) {
				return DeleteAllTaskHistoryCount.create({ tasksDeleted: 0 })
			}
		}

		const tasksDeleted = await this.taskHistory.deleteAllTaskHistory()
		await this.postStateToWebview()
		return DeleteAllTaskHistoryCount.create({
			tasksDeleted: tasksDeleted || totalTasks,
		})
	}

	async updateTaskHistory(item: HistoryItem): Promise<HistoryItem[]> {
		return this.taskHistory.updateTaskHistory(item)
	}

	async forkTaskAt(taskId: string, messageTs: number): Promise<string> {
		this.sessions.assertTaskAvailable(taskId)
		let newId = ""
		await this.sessionRebuilds.runExclusive(async () => {
			this.sessions.assertTaskAvailable(taskId)
			const parent = await this.taskHistory.findHistoryItem(taskId)
			if (!parent) throw new Error("Parent task not found")
			// The parent's effective task: a parent that is itself an aside may be stored unfiled.
			const taskGroupId = await resolveEffectiveTaskGroupId(parent, (id) => this.taskHistory.findHistoryItem(id))
			const visible =
				this.taskSessions.get(taskId)?.task.messageStateHandler.getClineMessages() ??
				(await this.taskHistory.getClineMessages(taskId))
			let temporaryHost: VscodeSessionHost | undefined
			const reader =
				this.sessions.getSession(taskId)?.sdkHost ?? (temporaryHost = await this.createRemoteConfigAwareSessionHost())
			const focusedId = this.task?.taskId
			try {
				const raw = await readCurrentMessages(reader, taskId)
				const initialMessages = buildAsideConversation(raw, visible, messageTs, parent.cwdOnTaskInitialization)
				const cwd = parent.cwdOnTaskInitialization || (await this.getWorkspaceRoot())
				const apiSelection =
					this.taskSessions.get(taskId)?.pendingApiSelection ??
					this.taskSessions.get(taskId)?.apiSelection ??
					this.sessions.getSession(taskId)?.apiSnapshot?.selection ??
					parent.apiSelection ??
					captureTaskApiSelection(this.stateManager)
				const config = await this.sessionConfigBuilder.build({ cwd, mode: "plan", apiSelection })
				config.sessionId = createSessionId()
				const input = buildStartSessionInput(config, { cwd, mode: "plan" })
				this.sessions.assertTaskAvailable(taskId)
				const { startResult } = await this.sessions.startNewSession({
					...input,
					initialMessages,
					sessionMetadata: {
						...input.sessionMetadata,
						apiSelection,
						taskMode: "plan",
						parentTaskId: taskId,
						forkedAtTs: messageTs,
						// Asides stay in their parent's task group.
						taskGroupId: taskGroupId ?? "",
					},
				})
				newId = startResult.sessionId
				const item = {
					...createHistoryItemFromSession(newId, `Aside: ${parent.task}`, config.modelId, cwd),
					apiSelection,
					parentTaskId: taskId,
					forkedAtTs: messageTs,
					taskGroupId,
				}
				await this.taskHistory.updateTaskHistoryItem(item)
				const context = this.getTaskSessionContext(newId)
				context.mode = "plan"
				context.apiSelection = apiSelection
				context.task.messageStateHandler.addMessages(await this.taskHistory.getClineMessages(newId))
				context.turn.set("awaiting_followup")
				this.sessions.setRunning(false, newId)
			} finally {
				try {
					this.sessions.focusSession(focusedId)
				} finally {
					await temporaryHost?.dispose("forkTaskAt")
				}
			}
		})
		await this.postStateToWebview()
		return newId
	}

	// ---- Message deep links ----

	/**
	 * Builds the vscode:// link for "Copy link" on a rendered row: the row's
	 * minted ts is resolved back to the stable SDK transcript index (plus a
	 * tool-call / text-row anchor) so the link survives reloads and resolves to
	 * exactly what the row renders.
	 */
	async buildMessageLink(threadId: string, messageTs: number): Promise<string> {
		const parent = await this.taskHistory.findHistoryItem(threadId)
		const visible =
			this.taskSessions.get(threadId)?.task.messageStateHandler.getClineMessages() ??
			(await this.taskHistory.getClineMessages(threadId))
		const raw = await this.taskHistory.readSessionMessages(threadId)
		const { messageIndex, anchor } = findMessageLinkTarget(raw, visible, messageTs, parent?.cwdOnTaskInitialization)
		if (messageIndex === undefined) {
			throw new Error("That message has no transcript position to link to yet")
		}
		return HostProvider.get().getCallbackUrl(buildMessageLinkPath(threadId, messageIndex, anchor))
	}

	/**
	 * Resolves a message link for the composer's paste -> message tag and for sending it as context. Returns
	 * the single referenced row's text (never the thread) plus attribution.
	 */
	async resolveMessageLink(
		threadId: string,
		messageIndex: number,
		anchor: MessageLinkAnchor = {},
	): Promise<{ threadId: string; messageIndex: number; threadTitle: string; author: string; text: string }> {
		const item = await this.taskHistory.findHistoryItem(threadId)
		const threadTitle = item ? item.title || item.task : ""
		const raw = await this.taskHistory.readSessionMessages(threadId).catch(() => [])
		const resolved = resolveLinkedMessageText(raw, messageIndex, anchor, item?.cwdOnTaskInitialization)
		if (!resolved) {
			return { threadId, messageIndex, threadTitle, author: "", text: "" }
		}
		return { threadId, messageIndex, threadTitle, author: resolved.role, text: resolved.text }
	}

	/**
	 * Opens a vscode:// message deep link: shows the target thread, then tells
	 * the webview which message to scroll to and briefly flash.
	 */
	async openMessageLink(threadId: string, messageIndex: number, anchor: MessageLinkAnchor = {}): Promise<void> {
		const info = await this.resolveMessageLink(threadId, messageIndex, anchor)
		await this.showTaskWithId(threadId)
		const { sendOpenMessageEvent } = await import("@/core/controller/ui/subscribeToOpenMessage")
		await sendOpenMessageEvent(threadId, messageIndex, info.text, anchor)
	}

	async toggleTaskSettled(taskId: string): Promise<void> {
		await this.taskHistory.toggleTaskSettled(taskId)
		await this.postStateToWebview()
	}

	/** Sets (or clears, when empty) the thread's user-set title. */
	async renameTask(taskId: string, title: string): Promise<void> {
		await this.taskHistory.renameTask(taskId, title)
		await this.postStateToWebview()
	}

	/** Replaces a thread's tags and the dismissed-auto-tags list wholesale. */
	async setThreadTags(taskId: string, tags: TaskTag[], dismissedAutoTags: string[]): Promise<void> {
		await this.taskHistory.setThreadTags(taskId, tags, dismissedAutoTags)
		await this.postStateToWebview()
	}

	// ---- Task groups ----

	/**
	 * Watch ~/.cline/data/task-groups so on-disk changes — hand-edited notes or
	 * writes from another Cline install sharing ~/.cline — refresh webview
	 * state (taskGroups list, note chips) the same way the user-instruction
	 * watcher picks up .clinerules edits.
	 */
	private async ensureTaskGroupsWatcher(): Promise<void> {
		if (this.isDisposed || this.taskGroupsWatcher) {
			return
		}
		try {
			const rootDir = taskGroupsRootDir()
			await fs.mkdir(rootDir, { recursive: true })
			this.taskGroupsWatcher = chokidar.watch(rootDir, { ignoreInitial: true })
			this.taskGroupsWatcher.on("all", (_event, file) => {
				const relative = path.relative(rootDir, file).split(path.sep)
				if (relative.length === 3 && relative[1] === "notebook" && relative[2].endsWith(".md")) {
					void this.notebookStore
						.captureSavedVersion(relative[0], relative[2].slice(0, -3))
						.catch((error) => Logger.warn("Failed to capture note history", error))
				}
				this.taskGroupsSummaryCache = undefined
				void this.notebookStore
					.refreshNoteIndexes()
					.catch((error) => Logger.warn("Failed to refresh notebook index", error))
				void this.postStateToWebview()
			})
		} catch (error) {
			Logger.warn("[SdkController] Failed to watch task-groups dir:", error)
		}
	}

	/** Group summaries for ExtensionState, cached briefly — state posts run on a 50ms debounce. */
	async listTaskGroups(): Promise<TaskGroupSummary[]> {
		const cached = this.taskGroupsSummaryCache
		if (cached && Date.now() - cached.at < 2000) {
			return cached.summaries
		}
		const summaries = await this.taskGroupStore.listGroupSummaries()
		this.taskGroupsSummaryCache = { summaries, at: Date.now() }
		return summaries
	}

	/** Notes across every task group (the composer's `#` menu); groups ordered by recency. */
	async listAllNotes(): Promise<{ taskGroupId: string; taskGroupTitle: string; notes: NotebookNoteMeta[] }[]> {
		const groups = await this.taskGroupStore.listGroupSummaries()
		return Promise.all(
			groups.map(async (group) => ({
				taskGroupId: group.id,
				taskGroupTitle: group.title,
				notes: await this.notebookStore.listNotes(group.id),
			})),
		)
	}

	/** Focus and HEAD events bypass the short state-post cache and post only changes. */
	async refreshCurrentBranch(): Promise<void> {
		if (this.isDisposed) return
		if (this.branchRefresh) {
			this.branchRefreshRequested = true
			return this.branchRefresh
		}
		const refresh = (async () => {
			do {
				this.branchRefreshRequested = false
				const cwd = await this.getWorkspaceRoot()
				const previous = this.currentBranchCache
				const branch = await getCurrentBranch(cwd)
				if (this.isDisposed) return
				this.currentBranchCache = { cwd, branch, at: Date.now() }
				if (previous?.cwd !== cwd || previous?.branch !== branch) await this.postStateToWebview()
			} while (this.branchRefreshRequested && !this.isDisposed)
		})()
		this.branchRefresh = refresh
		try {
			await refresh
		} finally {
			if (this.branchRefresh === refresh) this.branchRefresh = undefined
		}
	}

	/**
	 * Current git branch for ExtensionState, cached briefly to keep state posts
	 * cheap. Uses the last-known workspace root snapshot rather than awaiting
	 * the host — fine for the "link current branch" hint, which only matters
	 * when a real workspace is open.
	 */
	private async resolveCurrentBranch(): Promise<string | undefined> {
		const cwd = this.lastKnownWorkspaceRoot
		if (!cwd) {
			return undefined
		}
		const cached = this.currentBranchCache
		if (cached && cached.cwd === cwd && Date.now() - cached.at < 5000) {
			return cached.branch || undefined
		}
		const branch = await getCurrentBranch(cwd)
		this.currentBranchCache = { cwd, branch, at: Date.now() }
		return branch || undefined
	}

	/** The effective group of a thread (see {@link effectiveTaskGroupId}). */
	private effectiveTaskGroupId(item: HistoryItem, byId: Map<string, HistoryItem>): string | undefined {
		return effectiveTaskGroupId(item, byId)
	}

	/** Group detail: summary + note metas + member threads (the webview orders the timeline). */
	async getTaskGroup(
		id: string,
	): Promise<{ group: TaskGroupSummary; notes: NotebookNoteMeta[]; threads: TaskGroupThreadRow[] } | undefined> {
		const [group, notes, activity] = await Promise.all([
			this.taskGroupStore.getGroup(id),
			this.notebookStore.listNotes(id),
			this.notebookStore.summarizeActivity(id),
		])
		if (!group) {
			return undefined
		}
		const records = await this.taskHistory.listHistory({ hydrate: false, includeSubagents: true })
		const startedTs = new Map(records.map((record) => [record.sessionId, sessionRecordStartedTs(record)]))
		const historyItems = records.map(sessionHistoryRecordToHistoryItem)
		const byId = new Map(historyItems.map((item) => [item.id, item]))
		const threads: TaskGroupThreadRow[] = historyItems
			.filter((item) => this.effectiveTaskGroupId(item, byId) === id)
			.map((item) => ({
				threadId: item.id,
				title: item.title,
				task: item.task,
				ts: item.ts,
				startedTs: startedTs.get(item.id) ?? item.ts,
				parentTaskId: item.parentTaskId,
				isSubagent: item.isSubagent ?? false,
				read: activity.get(item.id)?.read ?? [],
				wrote: activity.get(item.id)?.wrote ?? [],
			}))
		return { group: { ...group, noteCount: notes.length }, notes, threads }
	}

	async createTaskGroup(input: { title: string; tags: TaskTag[]; threadId?: string }): Promise<string> {
		const group = await this.taskGroupStore.createGroup(input)
		if (input.threadId) await this.fileThread(input.threadId, group.id)
		this.taskGroupsSummaryCache = undefined
		await this.postStateToWebview()
		return group.id
	}

	async updateTaskGroup(
		id: string,
		update: { title?: string; tags?: TaskTag[]; branchSuggestionDismissed?: boolean },
	): Promise<TaskGroupSummary> {
		const group = await this.taskGroupStore.updateGroup(id, update)
		if (!group) {
			throw new Error(`Task group not found: ${id}`)
		}
		this.taskGroupsSummaryCache = undefined
		await this.postStateToWebview()
		return { ...group, noteCount: await this.taskGroupStore.noteCount(id) }
	}

	/** Deleting a task unfiles its threads; it never deletes threads. */
	async deleteTaskGroup(id: string): Promise<void> {
		const records = await this.taskHistory.listHistory({ hydrate: false })
		for (const record of records) {
			const item = sessionHistoryRecordToHistoryItem(record)
			if (item.taskGroupId === id) {
				await this.taskHistory.setTaskGroup(item.id, undefined)
				this.sessionConfigChanges.handleTaskGroupChanged(item.id)
			}
		}
		await this.taskGroupStore.deleteGroup(id)
		for (const record of records) {
			if (sessionHistoryRecordToHistoryItem(record).taskGroupId === id)
				this.sessionConfigChanges.handleTaskGroupChanged(record.sessionId)
		}
		this.taskGroupsSummaryCache = undefined
		await this.postStateToWebview()
	}

	/** Files a thread into a task group (empty taskGroupId unfiles it). */
	async setThreadTaskGroup(threadId: string, taskGroupId: string): Promise<void> {
		if (taskGroupId && !(await this.taskGroupStore.getGroup(taskGroupId))) {
			throw new Error(`Task group not found: ${taskGroupId}`)
		}
		await this.fileThread(threadId, taskGroupId || undefined)
		await this.postStateToWebview()
	}

	/**
	 * Stores a thread's task and carries every aside under it (nested ones too)
	 * along, so they keep the task's notebook, notes and inbox grouping. An aside
	 * is never filed on its own: that would split it from its parent, so filing
	 * one moves the thread it was forked from (and that thread's other asides).
	 * Each affected live session reloads its notebook.
	 */
	private async fileThread(threadId: string, taskGroupId: string | undefined): Promise<void> {
		const items = (await this.taskHistory.listHistory({ hydrate: false, includeSubagents: true })).map(
			sessionHistoryRecordToHistoryItem,
		)
		const byId = new Map(items.map((item) => [item.id, item]))
		const rootId = asideRootId(threadId, byId)
		await this.taskHistory.setTaskGroup(rootId, taskGroupId)
		this.sessionConfigChanges.handleTaskGroupChanged(rootId)
		for (const id of asideDescendantIds(rootId, items)) {
			if ((byId.get(id)?.taskGroupId || undefined) === taskGroupId) continue
			await this.taskHistory.setTaskGroup(id, taskGroupId)
			this.sessionConfigChanges.handleTaskGroupChanged(id)
		}
	}

	/** Creates a note file in the group's notebook; returns its absolute path. */
	async createNote(taskGroupId: string, name: string, description: string): Promise<string> {
		if (!(await this.taskGroupStore.getGroup(taskGroupId))) {
			throw new Error(`Task group not found: ${taskGroupId}`)
		}
		const note = await this.notebookStore.createNote(taskGroupId, { name, description })
		this.taskGroupsSummaryCache = undefined
		await this.postStateToWebview()
		return note.path
	}

	async openNote(taskGroupId: string, slug: string): Promise<void> {
		const filePath = this.notebookStore.notePath(taskGroupId, slug)
		if (!existsSync(filePath)) {
			throw new Error(`Note not found: ${slug}`)
		}
		await this.notebookStore.captureSavedVersion(taskGroupId, slug)
		await openFileIntegration(filePath)
	}

	async notebookAction(input: NotebookActionRequest): Promise<unknown> {
		const { taskGroupId: groupId, slug, threadId, revision } = input
		if (input.action === "edit" || input.action === "reload_draft") {
			// Reload reopens the user's rejected text against the card's current revision.
			const draft =
				input.action === "reload_draft" ? (await this.notebookStore.readDrafts(groupId, threadId))[slug] : undefined
			if (input.action === "reload_draft" && !draft) throw new Error("Your draft is no longer available")
			const refreshReview = async () => {
				await this.emitNotebookChanges(threadId)
				await this.postStateToWebview()
			}
			this.notebookEditors.push(
				await openPendingNoteEditor(this.notebookStore, input, refreshReview, {
					initialContent: draft?.content,
					draftTs: draft?.ts,
					onRejected: refreshReview,
				}),
			)
			return {}
		}
		if (input.action === "retry_draft" || input.action === "discard_draft") {
			if (input.action === "discard_draft") {
				await this.notebookStore.discardDraft(groupId, threadId, slug)
			} else {
				const draft = (await this.notebookStore.readDrafts(groupId, threadId))[slug]
				if (!draft) throw new Error("Your draft is no longer available")
				await this.notebookStore.editPending(groupId, threadId, revision, slug, draft.content, {
					supersedesDraftTs: draft.ts,
				})
			}
			await this.emitNotebookChanges(threadId)
			await this.postStateToWebview()
			return {}
		}
		if (input.action === "restore_pending") {
			const pending = await this.notebookStore.readPendingReview(groupId, threadId)
			const change = pending?.changes.find((change) => change.slug === slug)
			const version = (await this.notebookStore.history(groupId, slug)).find(
				(version) => version.id === change?.replacedUserVersion,
			)
			if (!version) throw new Error("Your version is no longer available")
			await this.notebookStore.editPending(groupId, threadId, revision, slug, version.content)
			await this.emitNotebookChanges(threadId)
			await this.postStateToWebview()
			return {}
		}
		if (input.action === "restore") {
			await this.notebookStore.restoreVersion(groupId, slug, input.versionId)
			this.taskGroupsSummaryCache = undefined
			await this.postStateToWebview()
			return {}
		}
		const note = await this.notebookStore.readNote(groupId, slug)
		if (input.action === "history") {
			// History outlives the saved note (never-saved, deleted or tombstoned notes keep their versions).
			await this.notebookStore.captureSavedVersion(groupId, slug)
			const versions = await this.notebookStore.history(groupId, slug)
			return {
				versions: versions.map((version) => ({ ...version, diff: notebookDiff(version.content, note?.content ?? "") })),
				conversions: await this.notebookStore.conversions(groupId, slug),
			}
		}
		if (!note) throw new Error("Note no longer exists")
		if (input.action === "open_conversion") {
			const links = await this.notebookStore.conversions(groupId, slug)
			const link = links.find((link) => link.path === input.versionId)
			if (!link) throw new Error("Conversion no longer available")
			await openFileIntegration(link.path)
			return {}
		}
		if (input.action !== "convert" && input.action !== "convert_preview") throw new Error("Unknown notebook action")
		const kind = input.kind as NotebookConversionKind
		if (!["rule", "skill", "workflow"].includes(kind)) throw new Error("Choose Rule, Skill or Workflow")
		const workspace = await this.getWorkspaceRoot()
		if (!input.isGlobal && !(await HostProvider.workspace.getWorkspacePaths({})).paths.length)
			throw new Error("No workspace folder open")
		const directory =
			kind === "skill"
				? await ensureAgentSkillsDirectoryExists({ isGlobal: input.isGlobal, workspacePath: workspace })
				: input.isGlobal
					? await (kind === "workflow" ? ensureWorkflowsDirectoryExists() : ensureRulesDirectoryExists())
					: path.join(workspace, kind === "workflow" ? ".clinerules/workflows" : ".clinerules")
		const file = notebookConversion(directory, kind, slug, note.content, input.description)
		if (input.action === "convert_preview") return file
		if (file.revision !== input.versionId) throw new Error("The note changed. Review the file again before creating it.")
		await createNotebookConversion(file)
		await this.notebookStore.addConversion(groupId, slug, { kind, path: file.path })
		if (kind === "rule") await refreshClineRulesToggles(this, workspace)
		if (kind === "workflow") await refreshWorkflowToggles(this, workspace)
		await this.postStateToWebview()
		return file
	}

	async applyNotebookChanges(
		threadId: string,
		taskGroupId: string,
		revision: string,
		items: { slug: string; include: boolean; editedContent?: string }[],
	): Promise<void> {
		const item = await this.taskHistory.findHistoryItem(threadId)
		try {
			const applied = await this.notebookStore.applyPendingChanges(taskGroupId, threadId, revision, items, {
				threadTitle: item?.title ?? item?.task ?? "",
			})
			await this.finishNotebookChanges(threadId, taskGroupId, revision, "applied", applied)
			await this.emitNotebookChanges(threadId)
		} catch (error) {
			await this.emitNotebookChanges(threadId)
			await this.postStateToWebview()
			throw error
		}
		this.taskGroupsSummaryCache = undefined
		await this.postStateToWebview()
	}

	async discardNotebookChanges(threadId: string, taskGroupId: string, revision: string): Promise<void> {
		const pending = await this.notebookStore.readPendingReview(taskGroupId, threadId)
		try {
			await this.notebookStore.discardPendingChanges(taskGroupId, threadId, revision)
		} catch (error) {
			await this.emitNotebookChanges(threadId)
			await this.postStateToWebview()
			throw error
		}
		if (pending) await this.finishNotebookChanges(threadId, taskGroupId, revision, "discarded", pending.changes)
		await this.emitNotebookChanges(threadId)
		await this.postStateToWebview()
	}

	/**
	 * Server-side history search: note bodies and session message text.
	 * Task/thread rows are fuzzy-matched client-side, so those kinds return
	 * no results here.
	 */
	async searchHistory(input: { query: string; kind?: string; limit?: number }): Promise<HistorySearchHit[]> {
		const kind = input.kind ?? "all"
		const generation = (this.historySearchGenerations.get(kind) ?? 0) + 1
		this.historySearchGenerations.set(kind, generation)
		const items = (await this.taskHistory.listHistory({ hydrate: false, includeSubagents: true })).map(
			sessionHistoryRecordToHistoryItem,
		)
		const byId = new Map(items.map((item) => [item.id, item]))
		const threads: HistorySearchThread[] = items.map((item) => ({
			id: item.id,
			title: item.title || item.task,
			ts: item.ts,
			taskGroupId: this.effectiveTaskGroupId(item, byId),
		}))
		return this.historySearcher.search({
			...input,
			threads,
			isCancelled: () => this.historySearchGenerations.get(kind) !== generation,
		})
	}

	private async resolveTaskNotebook(
		threadId?: string,
		metadata?: Record<string, unknown>,
	): Promise<TaskNotebookContext | undefined> {
		if (!threadId) return undefined
		const item = (await this.taskHistory.findHistoryItem(threadId)) ?? {
			...createHistoryItemFromSession(threadId, ""),
			taskGroupId: typeof metadata?.taskGroupId === "string" ? metadata.taskGroupId : undefined,
			parentTaskId: typeof metadata?.parentTaskId === "string" ? metadata.parentTaskId : undefined,
			runtimeOwnerTaskId: typeof metadata?.runtimeOwnerTaskId === "string" ? metadata.runtimeOwnerTaskId : undefined,
			isSubagent: metadata?.isSubagent === true,
		}
		const owner = await resolveNotebookOwner(item, (id) => this.taskHistory.findHistoryItem(id))
		if (!owner.taskGroupId) return undefined
		const group = await this.taskGroupStore.getGroup(owner.taskGroupId)
		if (!group) return undefined
		return {
			group,
			threadId,
			rootThreadId: owner.rootThreadId,
			store: this.notebookStore,
			resolveReaderThreadId: (agentId) =>
				Array.from(this.subagentThreads.values()).find((child) => child.agentId === agentId)?.id ?? threadId,
		}
	}

	private async emitNotebookChanges(threadId: string): Promise<void> {
		const item = await this.taskHistory.findHistoryItem(threadId)
		const rootThreadId = item
			? (await resolveNotebookOwner(item, (id) => this.taskHistory.findHistoryItem(id))).rootThreadId
			: threadId
		const reviews = await this.notebookStore.listPending(rootThreadId)
		if (!reviews.length) return
		const context = this.getTaskSessionContext(rootThreadId)
		if (!context.task.messageStateHandler.getClineMessages().length) {
			context.messages.replaceMessages(await this.taskHistory.getClineMessages(rootThreadId))
		}
		for (const pending of reviews) {
			const latest = latestNotebookChangesMessage(context.task.messageStateHandler.getClineMessages(), pending.groupId)
			const reuse = latest && JSON.parse(latest.text ?? "{}").status === "pending"
			const message = notebookChangesMessage(
				{
					revision: pending.revision,
					taskGroupId: pending.groupId,
					threadId: rootThreadId,
					status: "pending",
					changes: (await this.notebookStore.reviewDiffs(pending, rootThreadId)).changes,
				},
				reuse ? latest.ts : context.translator.nextTs(),
			)
			if (reuse) message.sdkMessageIndex = latest.sdkMessageIndex
			context.messages.emitHookMessage(message)
			await this.taskHistory.saveNotebookChangesMessage(rootThreadId, message)
		}
	}

	private async finishNotebookChanges(
		threadId: string,
		taskGroupId: string,
		revision: string,
		status: "applied" | "discarded",
		changes: NotebookChange[],
	): Promise<void> {
		const context = this.getTaskSessionContext(threadId)
		if (!context.task.messageStateHandler.getClineMessages().length) {
			context.messages.replaceMessages(await this.taskHistory.getClineMessages(threadId))
		}
		const latest = latestNotebookChangesMessage(context.task.messageStateHandler.getClineMessages(), taskGroupId, revision)
		const message = notebookChangesMessage(
			{
				taskGroupId,
				threadId,
				revision,
				status,
				changes,
				...(status === "applied" ? { appliedSlugs: changes.map((change) => change.slug) } : {}),
			},
			latest?.ts ?? context.translator.nextTs(),
		)
		message.sdkMessageIndex = latest?.sdkMessageIndex
		context.messages.emitHookMessage(message)
		await this.taskHistory.saveNotebookChangesMessage(threadId, message)
	}

	/**
	 * Aborts one running subagent of a live session. `subagentId` is the
	 * ThreadStrip chip id — `${statusMessageTs}:${index}` (see
	 * collectSubagents) — resolved to the spawn_agent tool call id through the
	 * session's translator state, then aborted via the SDK host. On success the
	 * entry is marked "stopped" and an updated status row is emitted.
	 */
	async stopSubagent(taskId: string, subagentId: string): Promise<boolean> {
		const child = this.subagentThreads?.get(subagentId)
		const ownerId = child?.runtimeOwnerTaskId ?? taskId
		const context = this.taskSessions.get(ownerId)
		const session = this.sessions.getSession(ownerId)
		if (!context || !session || !session.sdkHost.stopSubagent) return false
		if (child && (child.parentTaskId === taskId || ownerId === taskId) && child.spawnToolCallId) {
			// Only this child's run aborts: core resolves the parent's spawn_agent call with a
			// "Stopped by user" result, so the parent turn and sibling children keep running.
			const stopped = await session.sdkHost.stopSubagent(ownerId, child.spawnToolCallId)
			if (!stopped) return false
			context.interactions?.clearPending("Subagent stopped", child.agentId)
			this.taskSessions.get(child.parentTaskId ?? ownerId)?.translator.markSpawnAgentStopped(child.spawnToolCallId)
			await this.postStateToWebview()
			return true
		}

		const separator = subagentId.lastIndexOf(":")
		const statusTs = Number(subagentId.slice(0, separator))
		const index = Number(subagentId.slice(separator + 1))
		const translator = context.translator
		if (!Number.isFinite(statusTs) || !Number.isFinite(index) || statusTs !== translator.getCurrentSpawnAgentStatusTs()) {
			return false
		}
		const toolCallId = translator.getSpawnAgentToolCallId(index)
		if (!toolCallId || !(await session.sdkHost.stopSubagent(taskId, toolCallId))) {
			return false
		}
		translator.markSpawnAgentStopped(toolCallId)
		// Emit an updated status row so the transcript and chip show the stop
		// immediately, before the aborted child's content_end lands.
		const items = translator.getSpawnAgentItems()
		const stillRunning = items.some((entry) => entry.status === "running" || entry.status === "pending")
		const status = translator.buildSubagentStatus(
			stillRunning
				? "running"
				: items.some((entry) => entry.status === "failed" || entry.status === "stopped")
					? "failed"
					: "completed",
		)
		context.messages.emitHookMessage({
			ts: translator.getSpawnAgentStatusTs(),
			type: "say",
			say: "subagent" as ClineSay,
			text: JSON.stringify(status),
			partial: stillRunning,
		})
		this.sessions.setSubagentCounts(taskId, {
			total: translator.getSpawnAgentTotalCount(),
			live: items.filter((entry) => entry.status === "running" || entry.status === "pending").length,
		})
		await this.postStateToWebview()
		return true
	}

	async interjectPrompt(text: string, images?: string[], files?: string[], provenance?: ComposerProvenance): Promise<void> {
		if (this.subagentThreads?.has(this.task?.taskId ?? "")) throw new Error("Subagent threads are read-only.")
		this.sessions.assertTaskAvailable(this.task?.taskId)
		if (!text.trim() && !images?.length && !files?.length) throw new Error("Interject requires content")
		const task = this.task
		if (!task) throw new Error("No focused task")
		const active = this.sessions.getActiveSession()
		if (active) {
			const resolved = await this.resolveContextMentions(text, undefined, provenance)
			if (this.task !== task) throw new Error("Focused task changed during interject")
			await this.taskHistory.markTaskActive(task.taskId)
			if (extractTicketTags(text).length) await this.autoTagThread(task.taskId, text)
			this.messageTranslatorState.reset()
			this.messageTranslatorState.clearTurnOutcome()
			this.sessions.assertTaskAvailable(task.taskId)
			await this.taskControl.cancelTask(false, { text: resolved, images, files })
			this.turnStateTracker.set("streaming")
			await this.postStateToWebview()
			return
		}
		this.turnStateTracker.set("resumable")
		await this.taskControl.cancelTask(false)
		if (this.task !== task) throw new Error("Focused task changed during interject")
		this.turnStateTracker.set("idle")
		await this.askResponse(text, images, files, undefined, provenance)
	}

	async toggleTaskFavorite(taskId: string, isFavorited: boolean): Promise<void> {
		const historyItem = await this.taskHistory.findHistoryItem(taskId)
		if (!historyItem) {
			Logger.log(`[toggleTaskFavorite] Task not found in history: ${taskId}`)
			return
		}

		await this.taskHistory.updateTaskHistory({
			...historyItem,
			isFavorited,
		})
		await this.postStateToWebview()
	}

	// ---- Background command state ----

	updateBackgroundCommandState(running: boolean, taskId?: string): void {
		this.backgroundCommandRunning = running
		this.backgroundCommandTaskId = taskId
	}

	// ---- State management ----

	/**
	 * Request a webview state update.
	 *
	 * Callers fire this very frequently (notably the session event coordinator,
	 * once per streamed message/turn boundary), and each rebuild walks the full
	 * task history. StatePostDebouncer coalesces bursts into a single trailing
	 * rebuild to avoid hammering the extension host. The returned promise
	 * resolves once a snapshot reflecting this request has been shipped, or
	 * rejects if that rebuild failed.
	 */
	postStateToWebview(): Promise<void> {
		if (this.isDisposed) {
			return Promise.resolve()
		}
		return this.statePostDebouncer.post()
	}

	/** Build the current ExtensionState and push it to the webview immediately. */
	private async flushStateToWebview(): Promise<void> {
		// Import dynamically to avoid circular deps
		const { sendStateUpdate } = await import("@core/controller/state/subscribeToState")
		const state = await this.getStateToPostToWebview()
		await sendStateUpdate(state)
	}

	/**
	 * Reset the message translator's streaming state AND bump the conversation/replica fence
	 * (epoch). Called at every conversation boundary (task start/clear, history open, reinit,
	 * mode rebuild, new-session follow-up). Bumping the epoch BEFORE the new state is pushed
	 * means any straggler message/state from the previous task or render carries an older epoch
	 * and is dropped by the webview. Order matters: bump synchronously here, before any await.
	 */
	resetMessageTranslatorAndFence(): void {
		this.messageTranslatorState.reset()
		this.messageTranslatorState.getMinter().bumpEpoch()
	}

	async getStateToPostToWebview(snapshotAttempt = 0): Promise<ExtensionState> {
		// Build the base ExtensionState from StateManager, then layer the SDK's
		// task history on top.
		try {
			const snapshotTask = this.task
			const snapshotSession = this.sessions.getActiveSession()
			const snapshotEpoch = this.messageTranslatorState.getMinter().epoch
			syncTelemetrySettingFromSharedGlobalSettings(this.stateManager)
			const { getStateToPostToWebview: buildBaseState } = await import("@core/controller/state/getStateToPostToWebview")
			const state = await buildBaseState({
				task: snapshotTask,
				stateManager: this.stateManager,
				mcpHub: this.mcpHub,
				backgroundCommandRunning: this.backgroundCommandRunning,
				backgroundCommandTaskId: this.backgroundCommandTaskId,
				foregroundCommandRunning: this.foregroundCommands.isRunning,
				isRemoteConfigAvailable: this.isRemoteConfigAvailable,
				currentRemoteConfigRevision: this.currentRemoteConfigRevision,
				// Without this the webview always receives workspaceRoots: [] on the
				// SDK path (classic Controller exposes a public workspaceManager;
				// SdkController builds one lazily). The task-header working-directory
				// badge and anything else keyed on workspaceRoots depend on it.
				workspaceManager: await this.ensureWorkspaceManager(),
			})
			const sdkHistoryRecords = await this.taskHistory.listHistory({
				limit: 10_000,
				hydrate: false,
				includeSubagents: true,
			})
			const sdkTaskHistory = sdkHistoryRecords
				.map(sessionHistoryRecordToHistoryItem)
				.filter((item) => item.ts && item.task)
				.sort((a, b) => b.ts - a.ts)
			const legacyTaskHistory = state.taskHistory ?? []
			const mergedTaskHistoryById = new Map<string, HistoryItem>()

			// Keep the SDK records authoritative for migrated/new tasks, but append
			// legacy persisted history so pre-migration tasks still appear in the UI.
			for (const item of legacyTaskHistory) {
				mergedTaskHistoryById.set(item.id, item)
			}
			for (const item of sdkTaskHistory) {
				mergedTaskHistoryById.set(item.id, item)
			}

			// A just-started task may not be visible in SDK persisted history yet (the
			// history adapter can lag behind the active in-memory TaskProxy). Classic
			// state included the current task immediately, and the testing platform
			// asserts that taskHistory reflects newTask before the model turn completes.
			if (snapshotTask?.taskId && !mergedTaskHistoryById.has(snapshotTask.taskId)) {
				const taskMessage = snapshotTask.messageStateHandler
					.getClineMessages()
					.find((message) => message.type === "say" && message.say === "task" && message.text)
				if (taskMessage?.text) {
					mergedTaskHistoryById.set(snapshotTask.taskId, {
						id: snapshotTask.taskId,
						ts: taskMessage.ts || Date.now(),
						task: taskMessage.text,
						tokensIn: 0,
						tokensOut: 0,
						cacheWrites: 0,
						cacheReads: 0,
						totalCost: 0,
						modelId: snapshotTask.api?.getModel?.().id,
						cwdOnTaskInitialization: await this.getWorkspaceRoot(),
						taskGroupId: this.taskSessions.get(snapshotTask.taskId)?.taskGroupId,
					})
				}
			}

			// The same persistence lag applies to every OTHER live session: closing
			// (X) a just-started chat, or starting one in the background, unfocuses
			// it while it keeps running. Without a synthesized row the inbox drops
			// the chat entirely — it looks deleted and cannot be reopened.
			for (const session of (this.sessions.getSessions?.() ?? new Map()).values()) {
				if (mergedTaskHistoryById.has(session.sessionId)) continue
				const item = this.liveTaskHistoryItem(session.sessionId)
				if (item) {
					item.cwdOnTaskInitialization ??= await this.getWorkspaceRoot().catch(() => undefined)
					mergedTaskHistoryById.set(session.sessionId, item)
				}
			}

			for (const child of this.subagentThreads?.values() ?? []) {
				mergedTaskHistoryById.set(child.id, child)
			}
			// Asides show their parent's task, including ones filed wrong before the cascade existed.
			const sortedHistory = withEffectiveTaskGroups(
				Array.from(mergedTaskHistoryById.values())
					.filter((item) => item.ts && item.task)
					.sort((a, b) => b.ts - a.ts),
			)
			const focusedItem = snapshotTask ? mergedTaskHistoryById.get(snapshotTask.taskId) : undefined
			const processedTaskHistory = buildStateTaskHistory(sortedHistory, [
				focusedItem?.isSubagent ? undefined : focusedItem?.id,
				focusedItem?.parentTaskId,
			])

			let queuedPrompts: ExtensionState["queuedPrompts"] = []
			if (snapshotSession) {
				try {
					queuedPrompts = await snapshotSession.sdkHost.pendingPrompts("list", { sessionId: snapshotSession.sessionId })
				} catch (error) {
					Logger.error("[SdkController] Failed to list pending prompts for webview state:", error)
				}
			}

			// Stamp the snapshot with the current epoch and a fresh monotonic version, sampled
			// from the SAME counter that stamps messages. This lets the webview ignore stale
			// out-of-order state pushes and fence traffic from a previous task/render. Sampled
			// synchronously here (no await between sampling and return).
			const minter = this.messageTranslatorState.getMinter()
			// The transcript was copied before the awaits above. A snapshot stamped with a
			// newer epoch than its messages replaces the webview's transcript wholesale, and
			// messages appended at the old epoch after the copy would never arrive: the
			// webview drops their partial-stream copies as stale and a later snapshot only
			// merges. Rebuild once so the transcript and the stamp come from the same epoch.
			if (
				this.task !== snapshotTask ||
				this.sessions.getActiveSession() !== snapshotSession ||
				minter.epoch !== snapshotEpoch
			) {
				if (snapshotAttempt === 0) {
					return this.getStateToPostToWebview(1)
				}
				throw new Error("Task changed while building webview state")
			}
			const liveSelection =
				snapshotTask && snapshotSession?.sessionId === snapshotTask.taskId
					? (this.taskSessions?.get(snapshotTask.taskId)?.apiSelection ?? snapshotSession.apiSnapshot?.selection)
					: undefined
			const pendingSelection = snapshotTask ? this.taskSessions?.get(snapshotTask.taskId)?.pendingApiSelection : undefined
			const pickerSelection =
				pendingSelection ??
				liveSelection ??
				(snapshotTask ? this.taskSessions.get(snapshotTask.taskId)?.apiSelection : this.draftApiSelection)
			const liveConfiguration = snapshotSession?.apiSnapshot?.configuration
			const focusedSessionModels: ExtensionState["focusedSessionModels"] = liveConfiguration
				? Object.fromEntries(
						(["plan", "act"] as const).map((mode) => [
							mode,
							{
								profileId: mode === "plan" ? liveSelection?.askProfileId : liveSelection?.actProfileId,
								provider: liveConfiguration[`${mode}ModeApiProvider`],
								modelId: resolveActiveModelIdFromApiConfiguration(liveConfiguration, mode),
								reasoningEffort: liveConfiguration[`${mode}ModeReasoningEffort`],
							},
						]),
					)
				: undefined
			const child = snapshotTask ? this.subagentThreads?.get(snapshotTask.taskId) : undefined
			const focusedOwner = child ? (child.runtimeOwnerTaskId ?? child.parentTaskId) : snapshotTask?.taskId
			const ownerInteractions = focusedOwner ? this.taskSessions.get(focusedOwner)?.interactions : undefined
			const decision = child
				? this.taskSessions
						.get(child.runtimeOwnerTaskId ?? child.parentTaskId ?? "")
						?.interactions.getPendingDecision(child.agentId ?? "")
				: ownerInteractions?.getPendingDecision?.()
			const pendingSubagentDecisions: NonNullable<ExtensionState["pendingSubagentDecisions"]> = []
			for (const pending of ownerInteractions?.getPendingDecisions?.() ?? []) {
				const item = Array.from(this.subagentThreads?.values() ?? []).find(
					(item) =>
						(item.runtimeOwnerTaskId ?? item.parentTaskId) === focusedOwner &&
						item.agentId === pending.agentId &&
						(!child || item.id === child.id || item.parentTaskId === child.id),
				)
				if (item)
					pendingSubagentDecisions.push({
						taskId: item.id,
						name: item.task,
						kind: pending.kind,
						message: pending.message,
					})
			}
			const childDecisionStatuses = Object.fromEntries(
				Array.from(this.subagentThreads?.values() ?? [])
					.filter(
						(item) =>
							this.taskSessions
								.get(item.runtimeOwnerTaskId ?? item.parentTaskId ?? "")
								?.interactions.hasPendingDecisionForAgent?.(item.agentId ?? "") ||
							this.taskSessions
								.get(item.runtimeOwnerTaskId ?? item.parentTaskId ?? "")
								?.interactions.getPendingDecision(item.agentId ?? ""),
					)
					.map((item) => [item.id, "waiting" as const]),
			)
			const childRecord = child ? sdkHistoryRecords.find((record) => record.sessionId === child.id) : undefined
			const childStatus = child
				? (this.sessions.sessionStatuses[child.id] ?? (childRecord ? restoredThreadStatus(childRecord) : "done"))
				: undefined
			// The projected decision has its own freshness stamp. Once it resolves,
			// publish a newer child phase so the replica can leave awaiting_approval.
			const childTurn = child
				? {
						...(decision
							? {
									phase:
										decision.kind === "approval"
											? ("awaiting_approval" as const)
											: ("awaiting_followup" as const),
									anchorTs: decision.message.ts,
								}
							: this.turnStateTracker.get()),
						seq: minter.nextSeq(),
					}
				: undefined
			return {
				...state,
				...(child
					? {
							clineMessages: decision
								? [
										...state.clineMessages.filter((message) => message.ts !== decision.message.ts),
										decision.message,
									]
								: state.clineMessages,
							subagentView: {
								parentTaskId: child.parentTaskId!,
								agentId: child.agentId!,
								status: decision || childDecisionStatuses[child.id] ? ("waiting" as const) : childStatus!,
								pendingDecision: decision?.kind,
							},
						}
					: { subagentView: null }),
				focusedSessionModels,
				pendingSubagentDecisions,
				composerApiSelection: pickerSelection,
				composerNextMessageOnly: snapshotTask
					? !!this.taskSessions.get(snapshotTask.taskId)?.nextMessageSelection
					: false,
				composerApiConfiguration: pickerSelection
					? resolveApiConfigurationForTaskSelection(
							this.stateManager,
							state.apiConfiguration ?? {},
							state.mode,
							pickerSelection,
						)
					: undefined,
				currentTaskItem: snapshotTask?.taskId
					? processedTaskHistory.find((item) => item.id === snapshotTask.taskId)
					: undefined,
				taskHistory: processedTaskHistory,
				// Optional-called: unit tests drive getStateToPostToWebview with
				// partial controller stubs that don't carry these members.
				taskGroups:
					(await this.listTaskGroups?.().catch((error) => {
						Logger.warn("[SdkController] Failed to list task groups for webview state:", error)
						return undefined
					})) ?? [],
				currentBranch: await this.resolveCurrentBranch?.().catch(() => undefined),
				turnState:
					childTurn ??
					(decision
						? {
								phase: decision.kind === "approval" ? "awaiting_approval" : "awaiting_followup",
								anchorTs: decision.message.ts,
								seq: minter.nextSeq(),
							}
						: this.turnStateTracker.get()),
				queuedPrompts,
				sessionStatuses: {
					...Object.fromEntries(processedTaskHistory.map((item) => [item.id, "done" as const])),
					...Object.fromEntries(sdkHistoryRecords.map((record) => [record.sessionId, restoredThreadStatus(record)])),
					...this.sessions.sessionStatuses,
					...childDecisionStatuses,
				},
				// Live sessions report total + running; persisted history totals fill
				// in settled tasks whose sessions are gone.
				subagentCounts: {
					...Object.fromEntries(
						processedTaskHistory
							.filter((item) => (item.subagentCount ?? 0) > 0)
							.map((item) => [item.id, { total: item.subagentCount ?? 0, live: 0 }]),
					),
					...this.sessions.subagentCounts,
				},
				stateVersion: minter.nextSeq(),
				epoch: minter.epoch,
			}
		} catch (error) {
			Logger.error("[SdkController] Failed to get state for webview:", error)
			throw error
		}
	}

	// ---- Terminal settings ----

	/**
	 * Apply the user's terminal settings from StateManager to a terminal manager.
	 * Called once when the lazy terminal manager is first created, and can be
	 * called again when settings change at runtime.
	 */
	applyTerminalSettings(terminalManager: VscodeTerminalManager): void {
		const shellIntegrationTimeout = this.stateManager.getGlobalSettingsKey("shellIntegrationTimeout")
		if (shellIntegrationTimeout !== undefined) {
			terminalManager.setShellIntegrationTimeout(Number(shellIntegrationTimeout))
		}

		const terminalReuseEnabled = this.stateManager.getGlobalStateKey("terminalReuseEnabled")
		if (terminalReuseEnabled !== undefined) {
			terminalManager.setTerminalReuseEnabled(!!terminalReuseEnabled)
		}

		const defaultTerminalProfile = this.stateManager.getGlobalSettingsKey("defaultTerminalProfile")
		if (defaultTerminalProfile !== undefined && defaultTerminalProfile !== "") {
			terminalManager.setDefaultTerminalProfile(String(defaultTerminalProfile))
		}

		Logger.log(
			`[SdkController] Applied terminal settings: profile=${defaultTerminalProfile ?? "default"}, ` +
				`timeout=${shellIntegrationTimeout ?? 4000}, reuse=${terminalReuseEnabled ?? true}`,
		)
	}

	/**
	 * Get the terminal manager instance (if created).
	 * Used by updateSettings handlers to apply runtime changes.
	 */
	get terminalManager(): VscodeTerminalManager | undefined {
		return this._terminalManager
	}

	// ---- Workspace (kept from classic) ----

	private _workspaceManager?: WorkspaceRootManager
	private _workspaceManagerPathsKey?: string

	async ensureWorkspaceManager(): Promise<WorkspaceRootManager | undefined> {
		try {
			const { paths } = await HostProvider.workspace.getWorkspacePaths({})
			// When no workspace folder is open, fall back to the active session's
			// working directory (if known) or the shared chat workspace, the same
			// root getWorkspaceRoot() gives sessions. The legacy Controller always
			// seeded its manager with a fallback root (setupWorkspaceManager →
			// getCwd(getDesktopDir())), so @-mention file search kept working in
			// an empty window; returning undefined here instead made searchFiles
			// emit task.mention_failed (workspace_unavailable) with zero results.
			const validPaths = resolveWorkspaceManagerPaths(
				paths,
				this.lastKnownWorkspaceRoot ?? (await this.getNoWorkspaceFallback()),
			)
			if (validPaths.length === 0) {
				return undefined
			}
			// Rebuild only when the set of workspace folders changes
			const pathsKey = JSON.stringify(validPaths)
			if (!this._workspaceManager || this._workspaceManagerPathsKey !== pathsKey) {
				this._workspaceManager = await WorkspaceRootManager.fromPaths(validPaths)
				this._workspaceManagerPathsKey = pathsKey
			}
			return this._workspaceManager
		} catch (error) {
			Logger.warn("[SdkController] Failed to build workspace manager:", error)
			return undefined
		}
	}
}
