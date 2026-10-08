import type { WorkspaceContext } from "../extensions/context";
import { isClineProvider } from "../providers/utils";
import type { WorkspaceInfo } from "../session/workspace";
import { DEFAULT_CLINE_SYSTEM_PROMPTS } from "./system";

const WORKSPACE_CONFIGURATION_MARKER = "# Workspace Configuration";

/**
 * Explains the <user_input mode="..."> wrapper and <mode_notice> elements the
 * runtime stamps on user messages (prepareTurnInput / formatUserInputBlock).
 * Included in plan and act prompts so the model can interpret mode switches
 * and earlier messages tagged with the other mode. YOLO prompts omit these
 * instructions because they do not use the plan/act workflow.
 */
export const MODE_TAG_INSTRUCTIONS = `# Ask / Act Modes

User messages arrive wrapped in a <user_input mode="..."> tag. The mode attribute is the interaction mode the user was in when they sent that message: "plan" (labeled "Ask" in the UI) means ask-mode constraints applied (read-only investigation, direct answers -- no edits or state-changing commands), while "act" (or "yolo") means implementation was allowed. If the mode attribute changes between messages, the user switched modes -- the newest message's mode is what governs right now, regardless of what earlier messages allowed. A <mode_notice> block inside a message marks exactly when such a switch happened.`;

/**
 * Ask-mode behavioral contract, appended when the session mode is "plan"
 * (labeled "Ask" in hosts). Ask mode is read-only investigation: the model
 * answers the user's question directly instead of producing a plan artifact
 * or steering the user toward a mode switch. run_commands intentionally
 * stays available -- it is essential for read-only investigation -- so the
 * contract must spell out that it is inspection-only there. Prompting is the
 * first line of defense; the plan-mode command-guard hook (registered by the
 * core runtime builder for plan-mode sessions) is the hard backstop that
 * rejects file-editing run_commands calls with a tool error before approval
 * or execution.
 */
const ASK_MODE_INSTRUCTIONS_BASE = `# Ask Mode

You are in Ask mode. Your role is to answer the user's question directly -- investigate, explain, and advise, but do not change anything.

- Read files, search the codebase, inspect history, and gather whatever context you need to answer well
- Answer the question directly; do not produce a plan artifact or a step-by-step implementation outline unless the user asks for one
- Do NOT edit files, write code, run destructive commands, or make any changes
- Do NOT prompt the user to switch modes -- if the request requires changes, say so in your answer and let the user decide when to switch

The run_commands tool remains available in Ask mode strictly for read-only inspection -- listing files, searching (grep), reading configs, inspecting git history and diffs, checking tool versions, and the like. Never use it to change anything: no creating, modifying, or deleting files, no writing scripts that make changes, and no state-changing commands (installs, migrations, database or schema changes, container commands that mutate state, etc.). File-editing commands (rm/mv/cp, in-place edits like sed -i, output redirection to files outside /tmp, git commands that change the working tree, package installs) are hard-blocked in Ask mode: they are not executed and return a tool error instead, so do not attempt them.`;

export const ASK_MODE_INSTRUCTIONS = ASK_MODE_INSTRUCTIONS_BASE;

/**
 * @deprecated Ask mode has no switch-to-act contract. Kept as an alias for
 * callers that still import the plan-mode names; both resolve to the same
 * Ask-mode instructions.
 */
export const PLAN_MODE_INSTRUCTIONS = ASK_MODE_INSTRUCTIONS;

/** @deprecated See PLAN_MODE_INSTRUCTIONS. */
export const PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH = ASK_MODE_INSTRUCTIONS;

function redactRemoteUrlCredentials(remote: string): string {
	const schemeEnd = remote.indexOf("://");
	if (schemeEnd < 1) return remote;

	const authorityStart = schemeEnd + 3;
	let authorityEnd = authorityStart;
	while (authorityEnd < remote.length) {
		const char = remote[authorityEnd];
		if (
			char === "/" ||
			char === "?" ||
			char === "#" ||
			char.charCodeAt(0) <= 32
		) {
			break;
		}
		authorityEnd++;
	}

	const userInfoEnd = remote.lastIndexOf("@", authorityEnd - 1);
	if (userInfoEnd < authorityStart) return remote;
	return remote.slice(0, authorityStart) + remote.slice(userInfoEnd + 1);
}

export function processWorkspaceInfo(info: WorkspaceInfo): string {
	return JSON.stringify(
		{
			workspaces: {
				[info.rootPath]: {
					hint: info.hint,
					associatedRemoteUrls: info.associatedRemoteUrls?.map(
						redactRemoteUrlCredentials,
					),
					latestGitCommitHash: info.latestGitCommitHash,
					latestGitBranchName: info.latestGitBranchName,
				},
			},
		},
		null,
		2,
	);
}

function buildWorkspaceMetadata(
	rootPath: string,
	workspaceName?: string,
	metadata?: string,
): string {
	if (metadata?.trim()?.includes(WORKSPACE_CONFIGURATION_MARKER)) {
		return metadata.trim();
	}
	const body =
		metadata ||
		JSON.stringify(
			{
				workspaces: {
					[rootPath]: {
						hint: workspaceName || rootPath.split("/").at(-1) || rootPath,
					},
				},
			},
			null,
			2,
		);
	return `\n${WORKSPACE_CONFIGURATION_MARKER}\n${body}`;
}

/**
 * Options for building the Cline system prompt.
 *
 * Extends WorkspaceContext so callers can spread an ExtensionContext.workspace
 * directly. `workspaceRoot` is accepted as an alias for `rootPath` to support
 * existing call sites that set it explicitly.
 */
export interface ClineSystemPromptOptions
	extends Omit<WorkspaceContext, "rootPath"> {
	/**
	 * Workspace root path. Accepts either `rootPath` (from WorkspaceContext/WorkspaceInfo)
	 * or `workspaceRoot` (legacy alias) — whichever is provided will be used.
	 */
	rootPath?: string;
	/** Alias for rootPath — kept for backwards compatibility with existing call sites */
	workspaceRoot?: string;
	/** Per-request system prompt override */
	overridePrompt?: string;
	/** Provider ID — used to gate Cline-specific metadata injection */
	providerId?: string;
	/**
	 * @deprecated Ask mode no longer instructs the model to switch modes, so
	 * this flag has no effect. Kept for backwards compatibility with existing
	 * call sites.
	 */
	planModeSwitchTool?: boolean;
}

export function buildClineSystemPrompt(
	options: ClineSystemPromptOptions,
): string {
	const {
		ide = "Terminal Shell",
		mode,
		platform = "unknown",
		workspaceName,
		metadata,
		rules,
		overridePrompt,
		providerId,
		planModeSwitchTool: _planModeSwitchTool,
	} = options;
	const workspaceRoot = options.workspaceRoot ?? options.rootPath ?? "";
	const isCline = isClineProvider(providerId || "");

	if (overridePrompt?.trim()) {
		const trimmed = overridePrompt.trim();
		if (
			isCline &&
			metadata?.trim() &&
			!trimmed.includes(WORKSPACE_CONFIGURATION_MARKER)
		) {
			return `${trimmed}\n\n${buildWorkspaceMetadata(workspaceRoot, workspaceName, metadata)}`.trim();
		}
		return trimmed;
	}

	const basePrompt =
		mode === "yolo"
			? DEFAULT_CLINE_SYSTEM_PROMPTS.YOLO
			: DEFAULT_CLINE_SYSTEM_PROMPTS.ACT;

	// Keep mode semantics shared across hosts, but omit the plan/act workflow
	// instructions in YOLO mode. Caller rules apply in every mode.
	const effectiveRules = [
		rules,
		mode === "yolo" ? undefined : MODE_TAG_INSTRUCTIONS,
		mode === "plan" ? ASK_MODE_INSTRUCTIONS : undefined,
	]
		.filter(Boolean)
		.join("\n\n");

	return basePrompt
		.replace("{{PLATFORM_NAME}}", platform)
		.replace("{{CWD}}", workspaceRoot)
		.replace("{{CURRENT_DATE}}", new Date().toLocaleDateString())
		.replace("{{IDE_NAME}}", ide)
		.replace(
			"{{CLINE_METADATA}}",
			isCline
				? buildWorkspaceMetadata(workspaceRoot, workspaceName, metadata)
				: "",
		)
		.replace("{{CLINE_RULES}}", effectiveRules)
		.trim();
}
