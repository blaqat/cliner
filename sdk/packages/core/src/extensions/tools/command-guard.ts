/**
 * Plan-mode command blacklist for run_commands.
 *
 * Plan mode keeps run_commands available for read-only investigation, but
 * models (especially weaker ones) use it to edit files anyway. When the plan
 * runtime installs the command-guard extension, its beforeTool hook checks
 * each command against this blacklist before approval or execution.
 *
 * This is a simple blacklist, not a shell interpreter. Commands are lightly
 * preprocessed (quoted text, heredoc bodies, escapes, and comments are masked
 * so they cannot false-positive), split on shell separators, and the leading
 * command word of each part is compared against the lists below; output
 * redirection to files is also rejected. Shell/eval scripts are inspected
 * recursively, inline interpreter code is rejected, and opaque package
 * scripts require approval. This remains a blacklist, not a shell sandbox.
 */

import type { StructuredCommandInput } from "./schemas";

/** Commands that create, modify, or delete files. */
const BLOCKED_COMMANDS = new Set([
	// POSIX
	"rm",
	"rmdir",
	"unlink",
	"mv",
	"cp",
	"dd",
	"touch",
	"mkdir",
	"ln",
	"link",
	"chmod",
	"chown",
	"chgrp",
	"truncate",
	"shred",
	"install",
	"patch",
	"rsync",
	"mkfifo",
	"mknod",
	// Windows / PowerShell
	"del",
	"erase",
	"move",
	"ren",
	"rename",
	"md",
	"rd",
	"mklink",
	"copy",
	"xcopy",
	"robocopy",
	"new-item",
	"ni",
	"remove-item",
	"move-item",
	"copy-item",
	"rename-item",
	"set-content",
	"add-content",
	"clear-content",
	"out-file",
	// Unambiguous PowerShell aliases of the cmdlets above
	"mi",
	"ri",
	"cpi",
	"rni",
	"ac",
	"clc",
]);

/** Subcommands that mutate state, keyed by the command they belong to. */
const GIT_SUBCOMMANDS = new Set([
	"add",
	"am",
	"apply",
	"checkout",
	"cherry-pick",
	"clean",
	"clone",
	"commit",
	"init",
	"merge",
	"mv",
	"pull",
	"push",
	"rebase",
	"reset",
	"restore",
	"revert",
	"rm",
	"stash",
	"submodule",
	"switch",
	"worktree",
]);
const NODE_PM_SUBCOMMANDS = new Set([
	"install",
	"i",
	"ci",
	"add",
	"remove",
	"rm",
	"uninstall",
	"unlink",
	"link",
	"update",
	"up",
	"upgrade",
	"dedupe",
	"prune",
	"publish",
]);
const PIP_SUBCOMMANDS = new Set(["install", "uninstall", "add", "remove"]);
const CARGO_SUBCOMMANDS = new Set([
	"add",
	"remove",
	"rm",
	"install",
	"uninstall",
	"update",
	"new",
	"init",
	"publish",
]);
const GEM_SUBCOMMANDS = new Set(["install", "uninstall", "update", "cleanup"]);
const COMPOSER_SUBCOMMANDS = new Set([
	"install",
	"require",
	"remove",
	"update",
]);
const GO_SUBCOMMANDS = new Set(["install", "get"]);
const DOTNET_SUBCOMMANDS = new Set(["add", "remove"]);
const WINGET_SUBCOMMANDS = new Set(["install", "uninstall", "upgrade"]);
const NUGET_SUBCOMMANDS = new Set(["install", "update", "delete", "push"]);
const SYSTEM_PM_SUBCOMMANDS = new Set([
	"install",
	"reinstall",
	"remove",
	"purge",
	"uninstall",
	"upgrade",
	"autoremove",
	"add",
	"del",
]);
const BLOCKED_SUBCOMMANDS: Record<string, Set<string>> = {
	git: GIT_SUBCOMMANDS,
	npm: NODE_PM_SUBCOMMANDS,
	pnpm: NODE_PM_SUBCOMMANDS,
	yarn: NODE_PM_SUBCOMMANDS,
	bun: NODE_PM_SUBCOMMANDS,
	pip: PIP_SUBCOMMANDS,
	pip3: PIP_SUBCOMMANDS,
	pipx: PIP_SUBCOMMANDS,
	uv: PIP_SUBCOMMANDS,
	cargo: CARGO_SUBCOMMANDS,
	apt: SYSTEM_PM_SUBCOMMANDS,
	"apt-get": SYSTEM_PM_SUBCOMMANDS,
	dnf: SYSTEM_PM_SUBCOMMANDS,
	yum: SYSTEM_PM_SUBCOMMANDS,
	apk: SYSTEM_PM_SUBCOMMANDS,
	brew: SYSTEM_PM_SUBCOMMANDS,
	snap: SYSTEM_PM_SUBCOMMANDS,
	gem: GEM_SUBCOMMANDS,
	composer: COMPOSER_SUBCOMMANDS,
	go: GO_SUBCOMMANDS,
	dotnet: DOTNET_SUBCOMMANDS,
	winget: WINGET_SUBCOMMANDS,
	nuget: NUGET_SUBCOMMANDS,
};

/**
 * Read-only forms of otherwise-mutating git subcommands, keyed by
 * subcommand: `git stash list` inspects, `git stash` mutates.
 */
const READ_ONLY_GIT_FORMS: Record<string, Set<string>> = {
	stash: new Set(["list", "show"]),
	worktree: new Set(["list"]),
	submodule: new Set(["status", "summary"]),
};

/** Prefix commands to skip over to reach the command that actually runs. */
const WRAPPERS = new Set([
	"sudo",
	"doas",
	"env",
	"command",
	"builtin",
	"nohup",
	"time",
	"nice",
	"stdbuf",
	"timeout",
	"xargs",
]);

/** Shell reserved words that can precede the command word. */
const RESERVED_WORDS = new Set([
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"while",
	"until",
	"do",
	"done",
	"for",
	"case",
	"esac",
	"!",
	"{",
	"}",
]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/**
 * Redirect targets that never persist data to a file. Temp locations are
 * also allowed: the run_commands description tells models to capture
 * long-running output in a tmp file, and that never touches the workspace.
 * `..` segments are rejected so a temp prefix cannot smuggle a path back
 * into the workspace (`/tmp/../home/user/project/x`).
 */
function isAllowedRedirectTarget(rawTarget: string): boolean {
	const target = rawTarget.replace(/["']/g, "");
	if (/^(\/dev\/(null|stdout|stderr|tty)|nul:?)$/i.test(target)) {
		return true;
	}
	if (target.includes("..")) {
		return false;
	}
	return (
		target.startsWith("/tmp/") ||
		target.startsWith("/var/tmp/") ||
		target.startsWith("$TMPDIR") ||
		target.startsWith("${TMPDIR") ||
		// Windows temp locations (cmd and PowerShell forms)
		/^%te?mp%/i.test(target) ||
		/^\$env:te?mp/i.test(target)
	);
}

/** Basename, lowercased, quotes and a trailing .exe stripped. */
function normalizeCommandName(word: string): string {
	const base = word.replace(/["']/g, "").split(/[/\\]/).pop() ?? word;
	return base.toLowerCase().replace(/\.exe$/, "");
}

/**
 * Mask the parts of a command string that are data rather than commands, so
 * the blacklist scan below cannot false-positive on them: heredoc bodies are
 * dropped, quoted/escaped argv is replaced with placeholders, and comments
 * are removed. Placeholders are restored after splitting shell operators.
 */
function maskNonCommandText(command: string, quotedText: string[]): string {
	// Drop heredoc bodies (everything between `<<DELIM` and the DELIM line).
	const lines = command.split("\n");
	const kept: string[] = [];
	let heredocDelimiter: string | undefined;
	for (const line of lines) {
		if (heredocDelimiter !== undefined) {
			if (line.replace(/^\t+/, "") === heredocDelimiter) {
				heredocDelimiter = undefined;
			}
			continue;
		}
		kept.push(line);
		const heredoc = line.match(
			/(?<![<])<<-?\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_./-]+))/,
		);
		if (heredoc) {
			heredocDelimiter = heredoc[1] ?? heredoc[2] ?? heredoc[3];
		}
	}
	return (
		kept
			.join("\n")
			// Arithmetic expansion ($((3 > 2))) holds comparisons, not
			// commands or redirections.
			.replace(/\$\(\([\s\S]*?\)\)/g, "_")
			// Preserve quoted argv for shell -c/eval inspection without treating
			// separators in ordinary quoted data as shell operators.
			.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, (span) => {
				const value =
					span[0] === "'"
						? span.slice(1, -1)
						: span.slice(1, -1).replace(/\\(["\\$`\n])/g, "$1");
				quotedText.push(value);
				return `__guard_quote_${quotedText.length - 1}__`;
			})
			// Backslash-escaped characters are literal text.
			.replace(/\\(.)/g, (_, char) => {
				quotedText.push(char);
				return `__guard_quote_${quotedText.length - 1}__`;
			})
			// Comments.
			.replace(/(?:^|\s)#.*$/gm, " ")
	);
}

/** Check one command's tokens (command word + args) against the blacklist. */
function checkTokens(
	tokens: string[],
	approval = false,
	depth = 0,
): string | undefined {
	let index = 0;
	while (
		index < tokens.length &&
		(ENV_ASSIGNMENT.test(tokens[index]) || RESERVED_WORDS.has(tokens[index]))
	) {
		index += 1;
	}
	// Skip wrappers (sudo, env, xargs, timeout 30, ...) and their options.
	while (
		index < tokens.length &&
		WRAPPERS.has(normalizeCommandName(tokens[index]))
	) {
		index += 1;
		while (
			index < tokens.length &&
			(tokens[index].startsWith("-") ||
				tokens[index] === "{}" ||
				ENV_ASSIGNMENT.test(tokens[index]) ||
				/^\d+[smhd]?$/.test(tokens[index]))
		) {
			index += 1;
		}
	}
	if (index >= tokens.length) {
		return undefined;
	}

	let name = normalizeCommandName(tokens[index]);
	let args = tokens.slice(index + 1);
	// Package executors can hide formatter/fixer command names.
	if (
		name === "npx" ||
		name === "bunx" ||
		((name === "pnpm" || name === "yarn") && args[0] === "dlx")
	) {
		if (args[0] === "dlx") args = args.slice(1);
		const cursor = skipOptions(
			args,
			new Set(["-p", "--package", "--cache", "--registry"]),
		);
		name = normalizeCommandName(args[cursor] ?? "").replace(/@[^@]*$/, "");
		args = args.slice(cursor + 1);
	}

	if (
		new Set(["bash", "sh", "zsh", "dash", "fish"]).has(name) ||
		name === "eval"
	) {
		if (args.some((arg) => arg.startsWith("<<")))
			return `\`${name}\` (inline code)`;
		const scriptIndex = args.findIndex((arg) =>
			/^-[A-Za-z]*c[A-Za-z]*$/.test(arg),
		);
		const script =
			name === "eval"
				? (args[0] === "--" ? args.slice(1) : args).join(" ")
				: scriptIndex >= 0
					? args[scriptIndex + 1]
					: undefined;
		if (script !== undefined) {
			if (depth >= 4) return "nested shell code (inspection limit)";
			return inspectCommand(script, approval, depth + 1);
		}
	}

	// Inline code can import arbitrary write APIs or launch subprocesses.
	// Blocking all of it avoids pretending a write-API regex is a sandbox.
	const inlineFlag = /^-[ep]/;
	if (
		(/^python[\d.]*$/.test(name) && args.some((arg) => /^-c/.test(arg))) ||
		(["node", "bun"].includes(name) &&
			args.some(
				(arg) => inlineFlag.test(arg) || /^--(eval|print)(=|$)/.test(arg),
			)) ||
		(["ruby", "perl"].includes(name) &&
			args.some((arg) => /^-[A-Za-z]*e/.test(arg))) ||
		(name === "php" && args.some((arg) => /^-r/.test(arg))) ||
		(name === "deno" && args.includes("eval")) ||
		((/^python[\d.]*$/.test(name) ||
			["node", "bun", "deno", "ruby", "perl", "php"].includes(name)) &&
			args.some((arg) => arg.startsWith("<<")))
	) {
		return `\`${name}\` (inline code)`;
	}

	const hasFlag = (flags: string[]) =>
		args.some((arg) =>
			flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
		);
	const writes =
		(name === "prettier" && hasFlag(["--write", "-w"])) ||
		(name === "biome" &&
			args.some((arg) => ["check", "format", "lint"].includes(arg)) &&
			hasFlag(["--write", "--fix", "--apply"])) ||
		(name === "eslint" && hasFlag(["--fix"]) && !hasFlag(["--fix-dry-run"])) ||
		(name === "ruff" &&
			(hasFlag(["--fix"]) ||
				(args.includes("format") && !hasFlag(["--check", "--diff"])))) ||
		(["black", "isort"].includes(name) &&
			!hasFlag(["--check", "--check-only", "--diff"])) ||
		(["gofmt", "goimports"].includes(name) && hasFlag(["-w"])) ||
		(name === "rustfmt" &&
			!hasFlag(["--check"]) &&
			!args.some(
				(arg, i) =>
					arg === "--emit=stdout" ||
					(arg === "--emit" && args[i + 1] === "stdout"),
			)) ||
		(name === "cargo" && args.includes("fmt") && !hasFlag(["--check"])) ||
		(name === "dprint" && args.includes("fmt") && !hasFlag(["--diff"])) ||
		(name === "clang-format" && hasFlag(["-i"]));
	if (writes && !hasFlag(["--help", "-h", "--version"]))
		return `\`${name}\` (formatter writes files)`;

	if (approval) {
		const cursor = skipOptions(
			args,
			new Set([
				"-C",
				"--cwd",
				"--dir",
				"--prefix",
				"-w",
				"--workspace",
				"-F",
				"--filter",
			]),
		);
		const subcommand = args[cursor];
		if (
			(["npm", "pnpm", "yarn", "bun"].includes(name) &&
				["run", "run-script", "test"].includes(subcommand)) ||
			(["make", "gmake", "just", "task"].includes(name) &&
				!hasFlag(["--help", "-h", "--version"]))
		) {
			return `\`${name}\` (package script)`;
		}
	}

	// `| tee /tmp/log` is the documented way to capture output; only file
	// arguments outside tmp are a mutation.
	if (name === "tee") {
		const fileArgs = args.filter((arg) => !arg.startsWith("-"));
		return fileArgs.some((arg) => !isAllowedRedirectTarget(arg))
			? "`tee`"
			: undefined;
	}

	if (BLOCKED_COMMANDS.has(name)) {
		return `\`${name}\``;
	}

	const subcommands = BLOCKED_SUBCOMMANDS[name];
	if (subcommands) {
		// Help output never mutates (`git switch --help`).
		if (
			name === "git" &&
			args.some((arg) => arg === "--help" || arg === "-h")
		) {
			return undefined;
		}
		// First non-option arg is the subcommand; `git -c k=v` / `git -C dir`
		// take a value, so skip that too.
		const cursor = skipOptions(
			args,
			name === "git" ? GIT_VALUE_OPTIONS : new Set(),
		);
		const subcommand = args[cursor]?.toLowerCase();
		if (subcommand && subcommands.has(subcommand)) {
			const next = args[cursor + 1]?.toLowerCase();
			if (
				name === "git" &&
				next !== undefined &&
				READ_ONLY_GIT_FORMS[subcommand]?.has(next)
			) {
				return undefined;
			}
			return `\`${name} ${subcommand}\``;
		}
		// Classic yarn with no subcommand runs an install.
		if (name === "yarn" && args.length === 0) {
			return "`yarn` (install)";
		}
		return undefined;
	}

	// `python -m pip install ...` is pip.
	if (/^python[\d.]*$/.test(name)) {
		const moduleIndex = args.indexOf("-m");
		const module =
			moduleIndex === -1 ? undefined : args[moduleIndex + 1]?.toLowerCase();
		if (module === "pip" || module === "pip3") {
			const subcommand = args
				.slice(moduleIndex + 2)
				.find((arg) => !arg.startsWith("-"))
				?.toLowerCase();
			if (subcommand && PIP_SUBCOMMANDS.has(subcommand)) {
				return `\`pip ${subcommand}\``;
			}
		}
		return undefined;
	}

	// In-place edit flags on otherwise read-only text tools. The flag cluster
	// must end at the lowercase `i` (optionally followed by a `.suffix`), so
	// value-taking uppercase flags like `perl -Ilib` do not match.
	const IN_PLACE_FLAG = /^-[A-Za-z]*i(\..*)?$/;
	if (
		(name === "sed" || name === "gsed") &&
		args.some((arg) => IN_PLACE_FLAG.test(arg) || arg.startsWith("--in-place"))
	) {
		return "`sed -i` (in-place edit)";
	}
	if (name === "perl" && args.some((arg) => IN_PLACE_FLAG.test(arg))) {
		return "`perl -i` (in-place edit)";
	}
	if (/^[gnm]?awk$/.test(name)) {
		const usesInplace = args.some(
			(arg, argIndex) =>
				((arg === "-i" || arg === "--include") &&
					args[argIndex + 1]?.startsWith("inplace")) ||
				(arg.startsWith("-i") && arg.slice(2).startsWith("inplace")) ||
				arg.startsWith("--include=inplace"),
		);
		if (usesInplace) {
			return "`awk -i inplace` (in-place edit)";
		}
		return undefined;
	}
	if (
		name === "sort" &&
		args.some((arg) => arg.startsWith("-o") || arg.startsWith("--output"))
	) {
		return "`sort -o` (writes a file)";
	}
	if (name === "curl") {
		const writesFile = args.some(
			(arg) =>
				(!arg.startsWith("--") && /^-[A-Za-z]*[oO]/.test(arg)) ||
				arg.startsWith("--output") ||
				arg.startsWith("--remote-name"),
		);
		return writesFile ? "`curl -o` (writes a file)" : undefined;
	}
	if (name === "wget") {
		const readOnly = args.some(
			(arg, argIndex) =>
				arg === "--spider" ||
				/^-[A-Za-z]*O-$/.test(arg) ||
				arg === "--output-document=-" ||
				(arg === "-O" && args[argIndex + 1] === "-"),
		);
		return readOnly ? undefined : "`wget` (downloads files)";
	}
	if (name === "find") {
		if (args.includes("-delete")) {
			return "`find -delete`";
		}
		for (let argIndex = 0; argIndex < args.length; argIndex += 1) {
			if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[argIndex])) {
				continue;
			}
			const tail: string[] = [];
			for (
				let cursor = argIndex + 1;
				cursor < args.length && args[cursor] !== ";" && args[cursor] !== "+";
				cursor += 1
			) {
				tail.push(args[cursor]);
			}
			const nested = checkTokens(tail, approval, depth);
			if (nested) {
				return nested;
			}
		}
		return undefined;
	}

	return undefined;
}

/**
 * Inspect a run_commands entry and return a short description of the first
 * file-modifying construct found, or undefined when the command looks
 * read-only.
 */
export function findFileEditingCommand(
	command: string | StructuredCommandInput,
): string | undefined {
	return inspectCommand(command);
}

/** Check after the mutation blacklist; opaque scripts need approval even with terminal auto-approval. */
export function requiresPlanModeCommandApproval(
	command: string | StructuredCommandInput,
): boolean {
	return inspectCommand(command, true) !== undefined;
}

const GIT_VALUE_OPTIONS = new Set([
	"-c",
	"-C",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--config-env",
	"--super-prefix",
]);

function skipOptions(args: string[], valueOptions: Set<string>): number {
	let cursor = 0;
	while (cursor < args.length && args[cursor].startsWith("-")) {
		cursor += valueOptions.has(args[cursor]) ? 2 : 1;
	}
	return cursor;
}

function inspectCommand(
	command: string | StructuredCommandInput,
	approval = false,
	depth = 0,
): string | undefined {
	if (typeof command !== "string") {
		// Structured argv is executed without shell parsing, so only the
		// executable and argv matter (a ">" argument is a literal string).
		return checkTokens(
			[command.command, ...(command.args ?? [])],
			approval,
			depth,
		);
	}

	const quotedText: string[] = [];
	const masked = maskNonCommandText(command, quotedText);
	const restoreQuotes = (word: string) =>
		word.replace(
			/__guard_quote_(\d+)__/g,
			(_, index) => quotedText[Number(index)],
		);

	// Output redirection to a file (`>`, `>>`, `&>`), allowing /dev sinks,
	// fd duplication (`2>&1`, `>&2`), and /tmp output capture.
	const redirects = masked.matchAll(
		/(?:^|[^<>])(?:>{1,2}|&>{1,2})\s*([^\s;&|<>()]+)/g,
	);
	for (const redirect of redirects) {
		if (!isAllowedRedirectTarget(restoreQuotes(redirect[1]))) {
			return `output redirection (\`> ${redirect[1]}\`)`;
		}
	}

	// Check the command word of every simple command in the string.
	for (const segment of masked.split(/[\n;|&()`]+/)) {
		const blocked = checkTokens(
			segment.trim().split(/\s+/).filter(Boolean).map(restoreQuotes),
			approval,
			depth,
		);
		if (blocked) {
			return blocked;
		}
	}
	return undefined;
}

/**
 * Tool error returned in place of executing a blocked command in plan mode.
 */
export function formatPlanModeBlockedCommandError(reason: string): string {
	return (
		`Command not executed: ${reason} can modify files, and file modifications are blocked in plan mode. ` +
		"You are in PLAN MODE — explore, analyze, and present a plan; do not make changes. " +
		"Use read-only commands to inspect the project (redirecting output to /tmp, or %TEMP% on Windows, is allowed), " +
		"and if this change is part of the task, put it in your plan so it can run after the user approves switching to act mode."
	);
}
