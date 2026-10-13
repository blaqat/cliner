/**
 * Plan-mode command blacklist for run_commands.
 *
 * Plan mode keeps run_commands available for read-only investigation, but
 * models (especially weaker ones) use it to edit files anyway. When the plan
 * runtime installs the command-guard extension, its beforeTool hook checks
 * each command against this blacklist before approval or execution.
 *
 * This is a simple blacklist, not a shell interpreter. Commands are lightly
 * preprocessed (executable substitutions are inspected before literal quoted
 * text, heredoc bodies, escapes, and comments are masked), split on shell
 * separators, and the leading command word is compared against the lists; output
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
	"parallel",
	"exec",
	"caffeinate",
]);

/** Value-taking options must consume their argv, including attached values. */
const WRAPPER_VALUE_OPTIONS: Record<string, Set<string>> = {
	env: new Set([
		"-u",
		"--unset",
		"-C",
		"--chdir",
		"-S",
		"--split-string",
		"-a",
		"--argv0",
	]),
	xargs: new Set([
		"-I",
		"-J",
		"-i",
		"-n",
		"-P",
		"-L",
		"-l",
		"-s",
		"-d",
		"-E",
		"-e",
		"-a",
		"--replace",
		"--max-args",
		"--max-procs",
		"--max-lines",
		"--max-chars",
		"--delimiter",
		"--eof",
		"--arg-file",
		"--process-slot-var",
	]),
	parallel: new Set([
		"-j",
		"--jobs",
		"-I",
		"--replace",
		"-a",
		"--arg-file",
		"--colsep",
		"--arg-sep",
		"--delay",
		"--header",
		"-S",
		"--sshlogin",
	]),
	timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
	nice: new Set(["-n", "--adjustment"]),
	stdbuf: new Set(["-i", "--input", "-o", "--output", "-e", "--error"]),
	exec: new Set(["-a"]),
	sudo: new Set([
		"-u",
		"--user",
		"-g",
		"--group",
		"-h",
		"--host",
		"-p",
		"--prompt",
		"-C",
		"--close-from",
		"-T",
		"--command-timeout",
		"-R",
		"--chroot",
		"-D",
		"--chdir",
		"-a",
		"--auth-type",
		"-U",
		"--other-user",
		"-r",
		"--role",
		"-t",
		"--type",
	]),
	doas: new Set(["-u", "-C"]),
	time: new Set(["-f", "--format", "-o", "--output"]),
	caffeinate: new Set(["-t", "-w"]),
};

const WRAPPER_FLAGS: Record<string, Set<string>> = {
	env: new Set([
		"-",
		"-i",
		"--ignore-environment",
		"-0",
		"--null",
		"-v",
		"--debug",
	]),
	xargs: new Set([
		"-0",
		"--null",
		"-t",
		"--verbose",
		"-r",
		"--no-run-if-empty",
		"-p",
		"--interactive",
		"-x",
		"--exit",
		"-o",
		"--open-tty",
	]),
	parallel: new Set([
		"-0",
		"--null",
		"-k",
		"--keep-order",
		"--bar",
		"--eta",
		"--pipe",
		"--pipepart",
		"--dry-run",
		"--will-cite",
		"--quote",
		"--ungroup",
		"--line-buffer",
		"--link",
		"--xapply",
	]),
	timeout: new Set(["--preserve-status", "--foreground", "-v", "--verbose"]),
	nice: new Set(),
	stdbuf: new Set(),
	command: new Set(["-p", "-v", "-V"]),
	builtin: new Set(),
	exec: new Set(["-c", "-l"]),
	nohup: new Set(),
	sudo: new Set([
		"-A",
		"--askpass",
		"-b",
		"--background",
		"-E",
		"--preserve-env",
		"-H",
		"--set-home",
		"-i",
		"--login",
		"-K",
		"--remove-timestamp",
		"-k",
		"--reset-timestamp",
		"-l",
		"--list",
		"-n",
		"--non-interactive",
		"-P",
		"--preserve-groups",
		"-S",
		"--stdin",
		"-s",
		"--shell",
		"-V",
		"--version",
		"-v",
		"--validate",
	]),
	doas: new Set(["-L", "-n", "-s"]),
	time: new Set([
		"-p",
		"--portability",
		"-a",
		"--append",
		"-v",
		"--verbose",
		"-l",
	]),
	caffeinate: new Set(["-d", "-i", "-m", "-s", "-u"]),
};

const SHELL_COMMANDS = new Set(["bash", "sh", "zsh", "dash", "fish"]);
const INTERPRETER_COMMANDS = new Set([
	"node",
	"bun",
	"deno",
	"ruby",
	"perl",
	"php",
]);
const PACKAGE_RUNNERS = new Set([
	"npm",
	"pnpm",
	"yarn",
	"bun",
	"npx",
	"bunx",
	"make",
	"gmake",
	"just",
	"task",
]);
const FORMATTER_COMMANDS = new Set([
	"prettier",
	"biome",
	"eslint",
	"ruff",
	"black",
	"isort",
	"gofmt",
	"goimports",
	"rustfmt",
	"dprint",
	"clang-format",
]);

function isInspectableExecutable(name: string): boolean {
	return (
		WRAPPERS.has(name) ||
		BLOCKED_COMMANDS.has(name) ||
		BLOCKED_SUBCOMMANDS[name] !== undefined ||
		SHELL_COMMANDS.has(name) ||
		name === "eval" ||
		/^python[\d.]*$/.test(name) ||
		INTERPRETER_COMMANDS.has(name) ||
		PACKAGE_RUNNERS.has(name) ||
		FORMATTER_COMMANDS.has(name)
	);
}

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

interface Heredoc {
	delimiter: string;
	literal: boolean;
	stripTabs: boolean;
	length: number;
}

function readHeredoc(command: string, cursor: number): Heredoc | undefined {
	if (command[cursor - 1] === "<" || command[cursor + 2] === "<")
		return undefined;
	const match = command
		.slice(cursor)
		.match(/^<<(-?)[ \t]*((?:'[^']*'|"[^"]*"|\\.|[^\s;|&<>()'"\\])+)/);
	if (!match) return undefined;
	return {
		delimiter: match[2].replace(
			/'([^']*)'|"([^"]*)"|\\(.)/g,
			(_, single, double, escaped) => single ?? double ?? escaped,
		),
		literal: /['"\\]/.test(match[2]),
		stripTabs: match[1] === "-",
		length: match[0].length,
	};
}

/** Heredoc text cannot terminate the surrounding command substitution. */
function skipHeredocBodies(
	command: string,
	cursor: number,
	heredocs: Heredoc[],
	inspectBody?: (body: string) => void,
): number {
	for (const heredoc of heredocs) {
		const start = cursor;
		while (cursor < command.length) {
			const newline = command.indexOf("\n", cursor);
			const end = newline < 0 ? command.length : newline;
			const line = command.slice(cursor, end);
			if (
				(heredoc.stripTabs ? line.replace(/^\t+/, "") : line) ===
				heredoc.delimiter
			) {
				if (!heredoc.literal) inspectBody?.(command.slice(start, cursor));
				cursor = end + 1;
				break;
			}
			cursor = end;
			if (newline < 0) {
				if (!heredoc.literal) inspectBody?.(command.slice(start));
				break;
			}
			cursor += 1;
		}
	}
	heredocs.length = 0;
	return cursor;
}

/** Find the closing delimiter without mistaking quoted/nested parentheses for it. */
function substitutionEnd(command: string, start: number): number {
	const backtick = command[start] === "`";
	let parentheses = 1;
	let quote = "";
	const heredocs: Heredoc[] = [];
	for (
		let cursor = start + (backtick ? 1 : 2);
		cursor < command.length;
		cursor += 1
	) {
		const char = command[cursor];
		if (char === "\\" && quote !== "'") {
			cursor += 1;
			continue;
		}
		if (backtick && char === "`") return cursor;
		if (quote === "'") {
			if (char === "'") quote = "";
			continue;
		}
		if (command.startsWith("$(", cursor) || char === "`") {
			cursor = substitutionEnd(command, cursor);
			continue;
		}
		if (char === '"' || (!quote && char === "'")) {
			quote = quote ? "" : char;
			continue;
		}
		if (!quote && !backtick) {
			if (char === "#" && /[\s;|&()]/.test(command[cursor - 1])) {
				const newline = command.indexOf("\n", cursor);
				if (newline < 0) return command.length;
				cursor = newline - 1;
				continue;
			}
			if (command.startsWith("<<", cursor)) {
				const heredoc = readHeredoc(command, cursor);
				if (heredoc) {
					heredocs.push(heredoc);
					cursor += heredoc.length - 1;
					continue;
				}
			}
			if (char === "\n" && heredocs.length) {
				cursor = skipHeredocBodies(command, cursor + 1, heredocs) - 1;
				continue;
			}
			if (char === "(") parentheses += 1;
			if (char === ")" && --parentheses === 0) return cursor;
		}
	}
	return command.length;
}

/** Extract expansions that execute even when their surrounding text is data. */
function maskNonCommandText(
	command: string,
	quotedText: string[],
	substitutions: string[],
	heredocBody = false,
): string {
	const placeholder = (value: string) => {
		quotedText.push(value);
		return `__guard_quote_${quotedText.length - 1}__`;
	};
	const heredocs: Heredoc[] = [];
	let masked = "";
	for (let cursor = 0; cursor < command.length; ) {
		const char = command[cursor];
		if (char === "\\") {
			if (command[cursor + 1] !== "\n")
				masked += placeholder(command[cursor + 1] ?? "");
			cursor += 2;
			continue;
		}
		if (
			!heredocBody &&
			char === "#" &&
			(cursor === 0 || /[\s;|&()]/.test(command[cursor - 1]))
		) {
			const end = command.indexOf("\n", cursor);
			cursor = end < 0 ? command.length : end;
			continue;
		}
		if (
			command.startsWith("$(", cursor) ||
			char === "`" ||
			(!heredocBody &&
				(command.startsWith("<(", cursor) || command.startsWith(">(", cursor)))
		) {
			const end = substitutionEnd(command, cursor);
			const body = command.slice(cursor + (char === "`" ? 1 : 2), end);
			if (command.startsWith("$((", cursor)) {
				// Arithmetic itself is data, but it can contain command substitutions.
				maskNonCommandText(body, quotedText, substitutions, true);
			} else {
				substitutions.push(
					char === "`" ? body.replace(/\\([\\$`])/g, "$1") : body,
				);
			}
			masked += placeholder(command.slice(cursor, end + 1));
			cursor = end + 1;
			continue;
		}
		if (!heredocBody && (char === "'" || char === '"')) {
			const start = cursor++;
			while (cursor < command.length && command[cursor] !== char) {
				if (char === '"' && command[cursor] === "\\") {
					cursor += 2;
				} else if (
					char === '"' &&
					(command.startsWith("$(", cursor) || command[cursor] === "`")
				) {
					const end = substitutionEnd(command, cursor);
					maskNonCommandText(
						command.slice(cursor, end + 1),
						quotedText,
						substitutions,
						true,
					);
					cursor = end + 1;
				} else {
					cursor += 1;
				}
			}
			const value = command.slice(start + 1, cursor);
			masked += placeholder(
				char === "'"
					? value
					: value.replace(/\\\n/g, "").replace(/\\(["\\$`])/g, "$1"),
			);
			cursor += 1;
			continue;
		}
		if (!heredocBody && command.startsWith("<<", cursor)) {
			const heredoc = readHeredoc(command, cursor);
			if (heredoc) {
				heredocs.push(heredoc);
				masked += `<<${placeholder(heredoc.delimiter)}`;
				cursor += heredoc.length;
				continue;
			}
		}
		masked += char;
		cursor += 1;
		if (char === "\n" && heredocs.length) {
			cursor = skipHeredocBodies(command, cursor, heredocs, (body) => {
				maskNonCommandText(body, quotedText, substitutions, true);
			});
		}
	}
	return masked;
}

function checkWrappedCommand(
	name: string,
	args: string[],
	approval: boolean,
	depth: number,
	inputDriven: boolean,
): string | undefined {
	inputDriven ||= name === "xargs" || name === "parallel";
	const valueOptions = WRAPPER_VALUE_OPTIONS[name] ?? new Set<string>();
	const flags = WRAPPER_FLAGS[name];
	let cursor = 0;
	let unknownOption = false;
	const optionValue = (option: string, attached: string) => {
		if (attached) return attached;
		// xargs has optional replacement/eof/line-count values. Do not consume
		// a following executable as the value of one of these options.
		if (
			name === "xargs" &&
			["-i", "-l", "-e", "--replace", "--max-lines", "--eof"].includes(
				option,
			) &&
			(args[cursor]?.startsWith("-") ||
				isInspectableExecutable(normalizeCommandName(args[cursor] ?? "")))
		)
			return undefined;
		return args[cursor++];
	};
	while (cursor < args.length && args[cursor].startsWith("-")) {
		const option = args[cursor++];
		if (option === "--") break;
		if (name === "nice" && /^-\d+$/.test(option)) continue;
		if (["--help", "--version"].includes(option)) continue;
		const longOption = option.split("=")[0];
		if (option.startsWith("--")) {
			if (valueOptions.has(longOption)) {
				const value = option.includes("=")
					? option.slice(option.indexOf("=") + 1)
					: optionValue(longOption, "");
				if (
					name === "env" &&
					longOption === "--split-string" &&
					value !== undefined
				) {
					return checkEnvSplitString(
						value,
						args.slice(cursor),
						approval,
						depth,
						inputDriven,
					);
				}
			} else if (!flags?.has(longOption)) unknownOption = true;
			continue;
		}
		for (let letter = 1; letter < option.length; letter += 1) {
			const shortOption = `-${option[letter]}`;
			if (valueOptions.has(shortOption)) {
				const value = optionValue(shortOption, option.slice(letter + 1));
				if (name === "env" && shortOption === "-S" && value !== undefined) {
					return checkEnvSplitString(
						value,
						args.slice(cursor),
						approval,
						depth,
						inputDriven,
					);
				}
				break;
			}
			if (!flags?.has(shortOption)) unknownOption = true;
		}
	}
	if (name === "env") {
		while (cursor < args.length && ENV_ASSIGNMENT.test(args[cursor]))
			cursor += 1;
		if (args[cursor] === "--") cursor += 1;
	}
	if (name === "nice" && /^\+\d+$/.test(args[cursor] ?? "")) cursor += 1;
	if (name === "timeout") cursor += 1; // DURATION follows the options.
	const tail = args.slice(cursor);
	if (name === "parallel") {
		if (!tail.length || [":::", "::::"].includes(tail[0])) {
			return "`parallel` (input-driven code)";
		}
		// Parallel also accepts the entire command template as one quoted word.
		if (/\s/.test(tail[0]))
			return inspectCommand(tail[0], approval, depth, true);
	}
	const blocked = checkTokens(tail, approval, depth, inputDriven);
	if (blocked || !unknownOption) return blocked;

	// An unknown option may consume the token we mistook for the executable.
	// Inspect plausible executables in the remaining argv instead of trusting it.
	for (let index = 0; index < args.length; index += 1) {
		const candidate = normalizeCommandName(args[index]);
		if (isInspectableExecutable(candidate)) {
			const nested = checkTokens(
				args.slice(index),
				approval,
				depth,
				inputDriven,
			);
			if (nested) return nested;
			if (
				SHELL_COMMANDS.has(candidate) ||
				candidate === "eval" ||
				/^python[\d.]*$/.test(candidate) ||
				(INTERPRETER_COMMANDS.has(candidate) && candidate !== "bun")
			) {
				return `\`${candidate}\` (unknown wrapper option)`;
			}
			if (approval && PACKAGE_RUNNERS.has(candidate))
				return `\`${candidate}\` (unknown wrapper option)`;
		}
	}
	return undefined;
}

function checkEnvSplitString(
	value: string,
	args: string[],
	approval: boolean,
	depth: number,
	inputDriven: boolean,
): string | undefined {
	if (depth >= 4) return "nested shell code (inspection limit)";
	// env inserts split-string words back into its own argv, before the tail.
	const tail = args.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ");
	return inspectCommand(
		`env ${value} ${tail}`,
		approval,
		depth + 1,
		inputDriven,
	);
}

/** Check one command's tokens (command word + args) against the blacklist. */
function checkTokens(
	tokens: string[],
	approval = false,
	depth = 0,
	inputDriven = false,
): string | undefined {
	let index = 0;
	while (
		index < tokens.length &&
		(ENV_ASSIGNMENT.test(tokens[index]) || RESERVED_WORDS.has(tokens[index]))
	) {
		index += 1;
	}
	if (index >= tokens.length) {
		return undefined;
	}

	let name = normalizeCommandName(tokens[index]);
	let args = tokens.slice(index + 1);
	if (WRAPPERS.has(name))
		return checkWrappedCommand(name, args, approval, depth, inputDriven);
	if (approval && inputDriven && PACKAGE_RUNNERS.has(name)) {
		return `\`${name}\` (input-driven package script)`;
	}
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

	if (SHELL_COMMANDS.has(name) || name === "eval") {
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
			const blocked = inspectCommand(script, approval, depth + 1);
			if (blocked) return blocked;
		}
		// Input can supply the script, replace any part of it, or reach eval
		// through positional parameters. Its runtime contents are unavailable.
		if (inputDriven) return `\`${name}\` (input-driven code)`;
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
	if (
		inputDriven &&
		(/^python[\d.]*$/.test(name) ||
			(INTERPRETER_COMMANDS.has(name) && name !== "bun"))
	) {
		return `\`${name}\` (input-driven code)`;
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
			const nested = checkTokens(
				tail,
				approval,
				depth,
				inputDriven || tail.some((arg) => arg.includes("{}")),
			);
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
	inputDriven = false,
): string | undefined {
	if (typeof command !== "string") {
		// Structured argv is executed without shell parsing, so only the
		// executable and argv matter (a ">" argument is a literal string).
		return checkTokens(
			[command.command, ...(command.args ?? [])],
			approval,
			depth,
			inputDriven,
		);
	}

	const quotedText: string[] = [];
	const substitutions: string[] = [];
	const masked = maskNonCommandText(command, quotedText, substitutions);
	for (const substitution of substitutions) {
		if (depth >= 4) return "nested shell code (inspection limit)";
		const nested = inspectCommand(substitution, approval, depth + 1);
		if (nested) return nested;
	}
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
			inputDriven,
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
