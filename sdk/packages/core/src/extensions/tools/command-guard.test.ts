import { describe, expect, it } from "vitest";
import {
	findFileEditingCommand,
	formatPlanModeBlockedCommandError,
	requiresPlanModeCommandApproval,
} from "./command-guard";

/** Convenience: true when the guard blocks the command. */
function blocks(command: string): boolean {
	return findFileEditingCommand(command) !== undefined;
}

describe("findFileEditingCommand — read-only commands pass", () => {
	it.each([
		"ls -la",
		"pwd",
		"cat package.json",
		"head -n 50 src/index.ts",
		"tail -f /var/log/syslog",
		"grep -rn 'createShellTool' src/",
		"rg --files-with-matches 'ToolPresets'",
		"find . -name '*.ts' -not -path '*/node_modules/*'",
		"git status --short",
		"git log --oneline -20",
		"git diff HEAD~1",
		"git show HEAD:src/index.ts",
		"git blame src/index.ts",
		"git fetch origin main",
		"git branch --list",
		"wc -l src/*.ts",
		"du -sh node_modules",
		"df -h",
		"ps aux",
		"which node",
		"node --version",
		"npm ls --depth=0",
		"npm view zod versions",
		"bun run test",
		"bun test src/extensions",
		"cargo check",
		"cargo tree",
		"pip show requests",
		"brew list",
		"sed -n '1,20p' src/index.ts",
		"sed 's/foo/bar/' input.txt",
		"sort -u names.txt",
		"awk '{print $1}' data.csv",
		"awk '$3 > 100 {print}' data.csv",
		"diff a.txt b.txt",
		"curl -s https://example.com/api",
		"echo hello world",
		"printf '%s\\n' one two",
		"env | sort",
		"xargs -n1 echo < list.txt",
		"stat src/index.ts",
		"file dist/extension.js",
		"tree -L 2 src",
	])("allows %s", (command) => {
		expect(findFileEditingCommand(command)).toBeUndefined();
	});

	it("allows redirection to /dev/null and fd duplication", () => {
		expect(blocks("ls > /dev/null")).toBe(false);
		expect(blocks("ls 2> /dev/null")).toBe(false);
		expect(blocks("make check 2>&1 | tail -n 50")).toBe(false);
		expect(blocks("echo warn >&2")).toBe(false);
		expect(blocks("cmd &> /dev/null")).toBe(false);
	});

	it("allows redirection and tee into /tmp (documented output-capture pattern)", () => {
		expect(blocks("bun run build > /tmp/build.log 2>&1")).toBe(false);
		expect(blocks("npm test >> /tmp/test-output.txt")).toBe(false);
		expect(blocks("cargo build 2>&1 | tee /tmp/cargo.log")).toBe(false);
		expect(blocks("long_cmd > $TMPDIR/out.log")).toBe(false);
	});

	it("does not flag operators inside quotes", () => {
		expect(blocks("grep '=>' src/index.ts")).toBe(false);
		expect(blocks('echo "a > b"')).toBe(false);
		expect(blocks("git log --grep='rm -rf'")).toBe(false);
		expect(blocks('rg "touch(ed)?" docs/')).toBe(false);
		expect(blocks("echo 'mkdir is a command'")).toBe(false);
	});

	it("does not flag blocked names in argument position", () => {
		expect(blocks("man rm")).toBe(false);
		expect(blocks("which mv cp rm")).toBe(false);
		expect(blocks("git log -- rm.txt")).toBe(false);
		expect(blocks("cat mv-guide.md")).toBe(false);
	});

	it("does not flag heredoc bodies fed to read-only commands", () => {
		const command = ["cat <<'EOF'", "x = 10", "print(x > 5)", "EOF"].join("\n");
		expect(blocks(command)).toBe(false);
	});

	it("skips escaped characters and comments", () => {
		expect(blocks("echo a \\> b")).toBe(false);
		expect(blocks("ls # > notes.txt")).toBe(false);
	});
});

describe("findFileEditingCommand — file mutations are blocked", () => {
	it.each([
		["rm -rf build", "`rm`"],
		["rm file.txt", "`rm`"],
		["mv a.txt b.txt", "`mv`"],
		["cp src.txt dst.txt", "`cp`"],
		["touch new-file.ts", "`touch`"],
		["mkdir -p src/new-dir", "`mkdir`"],
		["chmod +x script.sh", "`chmod`"],
		["chown user file", "`chown`"],
		["ln -s a b", "`ln`"],
		["truncate -s 0 log.txt", "`truncate`"],
		["dd if=/dev/zero of=file bs=1M count=1", "`dd`"],
		["patch -p1 < fix.patch", "`patch`"],
		["rsync -a src/ dst/", "`rsync`"],
		["install -m 755 bin/tool /usr/local/bin", "`install`"],
	])("blocks %s", (command, reason) => {
		expect(findFileEditingCommand(command)).toBe(reason);
	});

	it("blocks Windows and PowerShell file mutations", () => {
		expect(findFileEditingCommand("del /f file.txt")).toBe("`del`");
		expect(findFileEditingCommand("move a.txt b.txt")).toBe("`move`");
		expect(findFileEditingCommand("Copy-Item a.txt b.txt")).toBe("`copy-item`");
		expect(findFileEditingCommand('Set-Content -Path f.txt -Value "x"')).toBe(
			"`set-content`",
		);
		expect(findFileEditingCommand('New-Item -ItemType File -Name "f"')).toBe(
			"`new-item`",
		);
		expect(findFileEditingCommand('"hi" | Out-File out.txt')).toBe(
			"`out-file`",
		);
	});

	it("blocks output redirection to workspace files", () => {
		expect(blocks("echo 'export const x = 1' > src/new.ts")).toBe(true);
		expect(blocks("cat template.txt >> config.yaml")).toBe(true);
		expect(blocks("printf 'y\\n' > answers.txt")).toBe(true);
		expect(blocks("cmd &> output.log")).toBe(true);
		expect(blocks("ls 2> errors.txt")).toBe(true);
		expect(findFileEditingCommand("echo hi > out.txt")).toBe(
			"output redirection (`> out.txt`)",
		);
	});

	it("blocks heredoc file writes (redirection carries the write)", () => {
		const command = [
			"cat > src/generated.ts <<'EOF'",
			"export const x = 1",
			"EOF",
		].join("\n");
		expect(blocks(command)).toBe(true);
	});

	it("blocks in-place editors", () => {
		expect(findFileEditingCommand("sed -i 's/a/b/' file.txt")).toBe(
			"`sed -i` (in-place edit)",
		);
		expect(blocks("sed -ri 's/a/b/g' file.txt")).toBe(true);
		expect(blocks("sed --in-place=.bak 's/a/b/' file.txt")).toBe(true);
		expect(blocks("gsed -i '' 's/a/b/' file.txt")).toBe(true);
		expect(blocks("perl -pi -e 's/a/b/' file.txt")).toBe(true);
		expect(blocks("gawk -i inplace '{gsub(/a/,\"b\")}1' file.txt")).toBe(true);
		expect(blocks("sort -o sorted.txt input.txt")).toBe(true);
	});

	it("blocks tee outside /tmp", () => {
		expect(findFileEditingCommand("ls | tee files.txt")).toBe("`tee`");
		expect(blocks("cmd | tee -a build.log")).toBe(true);
	});

	it("blocks git commands that change state", () => {
		expect(findFileEditingCommand("git add -A")).toBe("`git add`");
		expect(findFileEditingCommand("git commit -m 'msg'")).toBe("`git commit`");
		expect(blocks("git checkout main")).toBe(true);
		expect(blocks("git restore src/index.ts")).toBe(true);
		expect(blocks("git reset --hard HEAD~1")).toBe(true);
		expect(blocks("git clean -fd")).toBe(true);
		expect(blocks("git apply fix.patch")).toBe(true);
		expect(blocks("git stash")).toBe(true);
		expect(blocks("git push origin main")).toBe(true);
		expect(blocks("git pull")).toBe(true);
		expect(blocks("git rebase main")).toBe(true);
		// Global options before the subcommand are skipped.
		expect(blocks("git -C /repo -c user.name=x commit -m hi")).toBe(true);
	});

	it("blocks package-manager mutations", () => {
		expect(findFileEditingCommand("npm install lodash")).toBe("`npm install`");
		expect(blocks("npm i")).toBe(true);
		expect(blocks("pnpm add -D vitest")).toBe(true);
		expect(blocks("yarn add react")).toBe(true);
		expect(blocks("bun add zod")).toBe(true);
		expect(blocks("pip install requests")).toBe(true);
		expect(blocks("pip3 uninstall -y requests")).toBe(true);
		expect(blocks("cargo add serde")).toBe(true);
		expect(blocks("brew install jq")).toBe(true);
		expect(blocks("apt-get install -y curl")).toBe(true);
	});

	it("blocks find -delete", () => {
		expect(findFileEditingCommand("find . -name '*.log' -delete")).toBe(
			"`find -delete`",
		);
		expect(blocks("find . -type f -exec grep -l TODO {} +")).toBe(false);
	});
});

describe("findFileEditingCommand — evasion via nesting and wrappers", () => {
	it("unwraps wrapper commands", () => {
		expect(findFileEditingCommand("sudo rm -rf /data")).toBe("`rm`");
		expect(blocks("env FOO=1 mv a b")).toBe(true);
		expect(blocks("timeout 30 rm file")).toBe(true);
		expect(blocks("nohup cp a b")).toBe(true);
		expect(blocks("xargs rm < list.txt")).toBe(true);
		expect(blocks("command rm file")).toBe(true);
	});

	it("catches mutations in later pipeline/sequence segments", () => {
		expect(blocks("cd /tmp && rm -rf cache")).toBe(true);
		expect(blocks("ls; touch marker")).toBe(true);
		expect(blocks("true || rm file")).toBe(true);
		expect(blocks("ls | tee out.txt | wc -l")).toBe(true);
	});

	it("catches mutations inside unquoted command substitution", () => {
		expect(blocks("echo $(rm file)")).toBe(true);
		expect(blocks("echo `touch marker`")).toBe(true);
		expect(blocks("echo $(ls) done")).toBe(false);
	});

	it("skips leading env assignments to find the real command", () => {
		expect(blocks("FOO=bar rm file")).toBe(true);
		expect(blocks("FOO=bar ls")).toBe(false);
	});

	it("catches mutations after shell reserved words", () => {
		expect(blocks("for f in *.log; do rm $f; done")).toBe(true);
		expect(blocks("if true; then touch x; fi")).toBe(true);
		expect(blocks("for f in *.log; do echo $f; done")).toBe(false);
	});
});

describe("findFileEditingCommand — review feedback cases", () => {
	it("does not flag value-taking uppercase flags as in-place edits", () => {
		expect(blocks("perl -Ilib script.pl")).toBe(false);
		expect(blocks("perl -pi -e 's/a/b/' f.txt")).toBe(true);
		expect(blocks("perl -pi.bak -e 's/a/b/' f.txt")).toBe(true);
		expect(blocks("sed -Ei 's/a/b/' f.txt")).toBe(true);
	});

	it("ties awk inplace detection to the -i/--include flag", () => {
		expect(blocks("awk '{print $1}' inplace-notes.txt")).toBe(false);
		expect(blocks("gawk -i inplace '{gsub(/a/,\"b\")}1' f.txt")).toBe(true);
		expect(blocks("gawk --include=inplace '{print}' f.txt")).toBe(true);
	});

	it("allows read-only forms of mutating git subcommands", () => {
		expect(blocks("git stash list")).toBe(false);
		expect(blocks("git stash show -p")).toBe(false);
		expect(blocks("git worktree list")).toBe(false);
		expect(blocks("git submodule status")).toBe(false);
		expect(blocks("git switch --help")).toBe(false);
		expect(blocks("git stash")).toBe(true);
		expect(blocks("git stash pop")).toBe(true);
		expect(blocks("git worktree add ../wt")).toBe(true);
	});

	it("does not flag arithmetic expansion as redirection", () => {
		expect(blocks("echo $((3 > 2))")).toBe(false);
	});

	it("rejects temp paths that escape via ..", () => {
		expect(blocks("echo x > /tmp/../home/user/project/src/index.ts")).toBe(
			true,
		);
		expect(blocks("ls | tee /tmp/../etc/passwd")).toBe(true);
	});

	it("allows Windows temp output targets", () => {
		expect(blocks("echo x > %TEMP%\\out.log")).toBe(false);
		expect(blocks("echo x > $env:TEMP\\out.log")).toBe(false);
		expect(blocks("echo x > C:\\project\\out.log")).toBe(true);
	});

	it("blocks curl/wget file downloads but not plain fetches", () => {
		expect(findFileEditingCommand("curl -o src/out.ts https://x.test")).toBe(
			"`curl -o` (writes a file)",
		);
		expect(blocks("curl -sSLo /workspace/file https://x.test")).toBe(true);
		expect(blocks("curl --output out.bin https://x.test")).toBe(true);
		expect(blocks("curl -s https://x.test/api")).toBe(false);
		expect(findFileEditingCommand("wget https://x.test/file.zip")).toBe(
			"`wget` (downloads files)",
		);
		expect(blocks("wget --spider https://x.test")).toBe(false);
		expect(blocks("wget -qO- https://x.test | head")).toBe(false);
	});

	it("treats python -m pip as pip", () => {
		expect(findFileEditingCommand("python -m pip install requests")).toBe(
			"`pip install`",
		);
		expect(blocks("python3 -m pip uninstall -y requests")).toBe(true);
		expect(blocks("python3 -m pip show requests")).toBe(false);
		expect(blocks("python3 -m json.tool data.json")).toBe(false);
	});

	it("blocks PowerShell cmdlet aliases and case variants", () => {
		expect(findFileEditingCommand("mi a.txt b.txt")).toBe("`mi`");
		expect(blocks("ri -Force file.txt")).toBe(true);
		expect(blocks("REMOVE-ITEM file.txt")).toBe(true);
		expect(blocks("Set-Content f.txt 'x'")).toBe(true);
	});

	it("covers more package managers", () => {
		expect(blocks("winget install Some.App")).toBe(true);
		expect(blocks("nuget install Newtonsoft.Json")).toBe(true);
		expect(blocks("gem install rails")).toBe(true);
		expect(blocks("composer require vendor/pkg")).toBe(true);
		expect(blocks("go install ./cmd/tool")).toBe(true);
		expect(blocks("go get example.com/mod")).toBe(true);
		expect(blocks("dotnet add package Serilog")).toBe(true);
		expect(blocks("go build ./...")).toBe(false);
		expect(blocks("go test ./...")).toBe(false);
		expect(blocks("dotnet build")).toBe(false);
		expect(blocks("winget list")).toBe(false);
	});

	it("blocks bare classic yarn (implicit install)", () => {
		expect(findFileEditingCommand("yarn")).toBe("`yarn` (install)");
		expect(blocks("yarn --version")).toBe(false);
	});

	it("blocks mutating find -exec and xargs placeholder commands", () => {
		expect(blocks("find . -name '*.tmp' -exec rm {} \\;")).toBe(true);
		expect(blocks("find . -type f -execdir chmod +x {} +")).toBe(true);
		expect(blocks("find . -type f -exec grep -l TODO {} +")).toBe(false);
		expect(blocks("find . -name '*.ts' | xargs -I {} rm {}")).toBe(true);
	});
});

describe("findFileEditingCommand — structured commands", () => {
	it("checks structured command executables and argv", () => {
		expect(
			findFileEditingCommand({ command: "rm", args: ["-rf", "build"] }),
		).toBe("`rm`");
		expect(
			findFileEditingCommand({ command: "git", args: ["commit", "-m", "x"] }),
		).toBe("`git commit`");
		expect(findFileEditingCommand({ command: "/bin/rm", args: ["file"] })).toBe(
			"`rm`",
		);
		expect(
			findFileEditingCommand({ command: "git", args: ["status"] }),
		).toBeUndefined();
		expect(
			findFileEditingCommand({ command: "ls", args: ["-la"] }),
		).toBeUndefined();
	});

	it("does not shell-parse structured argv values", () => {
		// `>` here is a literal argument, not a shell redirection.
		expect(
			findFileEditingCommand({ command: "grep", args: [">", "file.txt"] }),
		).toBeUndefined();
	});
});

describe("Ask-mode command guard gaps", () => {
	it.each([
		'env -u HOME sh -c "touch file"',
		'env --unset HOME sh -c "touch file"',
		'env -C /tmp --unset=HOME FOO=bar sh -c "touch file"',
		'env --chdir=/tmp -i -- sh -c "touch file"',
		"env -S 'sh -c \"touch file\"'",
		"env --split-string='sh -c \"touch file\"'",
		'env -S "sh -c" "touch file"',
		'xargs -I ARG sh -c "touch file"',
		'xargs -IARG sh -c "touch file"',
		'xargs -i sh -c "touch file"',
		'xargs --replace sh -c "touch file"',
		'xargs -i ARG -n 1 -P 2 -L 1 -s 1024 -d : -E STOP -a /tmp/list sh -c "touch file"',
		'xargs --replace=ARG --max-args 1 --max-procs=2 --max-lines 1 --max-chars=1024 --delimiter : --eof STOP --arg-file /tmp/list sh -c "touch file"',
		'timeout -s TERM 10 sh -c "touch file"',
		'timeout --signal=TERM -k 1s 0.5m sh -c "touch file"',
		'nice -n 10 sh -c "touch file"',
		'nice -10 sh -c "touch file"',
		'nice +10 sh -c "touch file"',
		'nice --adjustment=10 nohup sh -c "touch file"',
		'stdbuf -i 0 -o L -e 0 sh -c "touch file"',
		'stdbuf --input=0 --output L --error=0 sh -c "touch file"',
		'command -p builtin exec -a label sh -c "touch file"',
		'sudo -u root -g wheel -h host -p prompt -C 3 -T 10 -R /tmp -D /tmp sh -c "touch file"',
		'sudo --user=root --group wheel --host=host --prompt prompt --chdir=/tmp sh -c "touch file"',
		'doas -u root -C /tmp/doas.conf sh -c "touch file"',
		'time -f format sh -c "touch file"',
		'caffeinate -di -t 10 -w 123 sh -c "touch file"',
	])("consumes wrapper option values before blocking the executable: %s", (command) => {
		expect(findFileEditingCommand(command)).toBe("`touch`");
	});

	it.each([
		"env -u HOME bun run build",
		"env -S 'bun run build'",
		"env --chdir /tmp -i FOO=bar -- bun run check-types",
		"xargs -I ARG bun run check-types",
		"xargs -i bun run check-types",
		"xargs --replace bun run check-types",
		"timeout -s TERM -k 2s 10 bun run check-types",
		"sudo -u root nice -n 10 bun run check-types",
	])("requires approval for package scripts behind wrapper options: %s", (command) => {
		expect(blocks(command)).toBe(false);
		expect(requiresPlanModeCommandApproval(command)).toBe(true);
	});

	it("does not consume a formatter as an optional xargs replacement value", () => {
		expect(blocks("xargs -i prettier --write src")).toBe(true);
		expect(blocks("xargs --replace prettier --write src")).toBe(true);
		expect(blocks("xargs -i sh -c 'git status'")).toBe(false);
	});

	it.each([
		'env --unknown VALUE sh -c "touch file"',
		'xargs --unknown VALUE node -e "console.log(1)"',
		'timeout --unknown VALUE 10 sh -c "touch file"',
	])("does not trust an executable after unknown wrapper options: %s", (command) => {
		expect(blocks(command)).toBe(true);
	});

	it("requires package approval after unknown wrapper options", () => {
		const command = "env --unknown VALUE bun run build";
		expect(blocks(command)).toBe(false);
		expect(requiresPlanModeCommandApproval(command)).toBe(true);
	});

	it.each([
		'echo "$(touch file)"',
		'echo "`touch file`"',
		'echo "$(echo "$(touch file)")"',
		'echo "$(touch "file with spaces")"',
		"echo \"$(printf '%s' 'literal )'; touch file)\"",
		"echo $((1 + $(touch file)))",
		'echo "$(echo ok # literal )\ntouch file)"',
		"echo \"$(cat <<'EOF'\n)\nEOF\ntouch file\n)\"",
		"cat <<'FIRST' <<SECOND\n$(echo literal)\nFIRST\n$(touch file)\nSECOND",
		"cat <<EOF\n$(touch file)\nEOF",
		"cat <<EOF\n'$(touch file)'\nEOF",
		"cat <<EOF\n`touch file`\nEOF",
		"cat <<-EOF\n\t$(touch file)\n\tEOF",
		"cat <(touch file)",
		"cat >(touch file)",
	])("blocks executable substitutions before masking text: %s", (command) => {
		expect(findFileEditingCommand(command)).toBe("`touch`");
	});

	it.each([
		'echo "$(bun run check-types)"',
		'echo "`bun run check-types`"',
		"cat <<EOF\n$(bun run check-types)\nEOF",
		"cat <(bun run check-types)",
		"cat >(bun run check-types)",
	])("requires approval for package scripts in executable substitutions: %s", (command) => {
		expect(blocks(command)).toBe(false);
		expect(requiresPlanModeCommandApproval(command)).toBe(true);
	});

	it.each([
		"git -C x log",
		"rg foo",
		"cat file",
		"cat file | tee /tmp/x",
		'echo "$HOME"',
		"echo '$(touch file)'",
		"echo '`touch file`'",
		'echo "\\$(touch file)"',
		'echo "\\`touch file\\`"',
		"cat <<'EOF'\n$(touch file) `touch file`\nEOF",
		'cat <<"EOF"\n$(touch file) `touch file`\nEOF',
		"cat <<\\EOF\n$(touch file)\nEOF",
		"cat <<E'OF'\n$(touch file)\nEOF",
		"cat <<< '$(touch file)'",
		'echo "<(touch file) >(touch file)"',
		"cat <<EOF\n<(touch file) >(touch file)\nEOF",
		"cat <<EOF\n\\$(touch file) \\`touch file\\`\nEOF",
		"echo ok # $(touch file)",
		'echo "$(git -C x log)"',
		"env -u HOME cat file",
		"xargs -I ARG cat ARG",
		"timeout -s TERM 10 rg foo",
		"env -S 'cat file'",
	])("preserves literal text and read-only commands without approval: %s", (command) => {
		expect(blocks(command)).toBe(false);
		expect(requiresPlanModeCommandApproval(command)).toBe(false);
	});

	it("unwraps structured wrapper argv without executing literal substitutions", () => {
		expect(
			findFileEditingCommand({
				command: "env",
				args: ["-u", "HOME", "sh", "-c", "touch file"],
			}),
		).toBe("`touch`");
		expect(
			requiresPlanModeCommandApproval({
				command: "env",
				args: ["-u", "HOME", "bun", "run", "build"],
			}),
		).toBe(true);
		expect(
			findFileEditingCommand({ command: "echo", args: ["$(touch file)"] }),
		).toBeUndefined();
	});

	it.each([
		'bash -c "touch file"',
		"sh -lc 'rm file'",
		"zsh -c 'echo x > file'",
		"dash -c 'mv a b'",
		"fish -c 'cp a b'",
		"eval 'mkdir dir'",
		"eval -- 'touch file'",
		"bash -cl 'touch file'",
		'eval "touch" "file"',
		"bash -c \"sh -c 'touch file'\"",
		"sudo bash -c 'git reset --hard'",
		"find . -exec sh -c 'rm file' \\;",
	])("recursively blocks shell code: %s", (command) => {
		expect(blocks(command)).toBe(true);
	});

	it("fails closed when shell recursion exceeds the inspection limit", () => {
		let command = "ls";
		for (let i = 0; i < 5; i++) command = `bash -c ${JSON.stringify(command)}`;
		expect(findFileEditingCommand(command)).toContain("inspection limit");
	});

	it.each([
		"python -c \"open('file', 'w').write('x')\"",
		'python3 -c "print(1)"',
		"node -e \"require('fs').writeFileSync('file', 'x')\"",
		'node --eval="console.log(1)"',
		'node -p "1+1"',
		'bun -e "console.log(1)"',
		'deno eval "console.log(1)"',
		'ruby -e \'File.write("file", "x")\'',
		"perl -e 'print 1'",
		"php -r 'echo 1;'",
		"python3 <<'EOF'\nopen('file', 'w')\nEOF",
		"bash <<'EOF'\ntouch file\nEOF",
	])("blocks all inline interpreter code: %s", (command) => {
		expect(blocks(command)).toBe(true);
	});

	it.each([
		"prettier --write src",
		"prettier -w src",
		"biome check --write src",
		"biome format --fix src",
		"biome lint --apply src",
		"eslint --fix src",
		"ruff check --fix src",
		"ruff format src",
		"black src",
		"isort src",
		"gofmt -w file.go",
		"goimports -w file.go",
		"rustfmt file.rs",
		"cargo fmt",
		"dprint fmt",
		"clang-format -i file.cpp",
		"npx prettier --write src",
		"bunx biome check --write src",
		"pnpm dlx eslint --fix src",
		"yarn dlx prettier -w src",
		"npx --yes --package prettier prettier --write src",
		"bunx @biomejs/biome@2 check --write src",
	])("blocks formatter writes: %s", (command) => {
		expect(blocks(command)).toBe(true);
	});

	it.each([
		"bash -c 'git status'",
		"eval 'ls | head'",
		'echo "bash -c touch file"',
		'rg "python -c" src',
		"prettier --check src",
		"biome check src",
		"eslint src",
		"ruff check src",
		"ruff format --check src",
		"ruff format --diff src",
		"black --check src",
		"isort --check-only src",
		"gofmt file.go",
		"goimports file.go",
		"rustfmt --check file.rs",
		"rustfmt --emit stdout file.rs",
		"cargo fmt -- --check",
		"dprint check",
		"clang-format file.cpp",
		"npx prettier --check src",
		"cat file | tee /tmp/x",
		"node -c file.js",
		'git --git-dir "/repo/.git" --work-tree /repo status',
	])("allows read-only cases: %s", (command) => {
		expect(blocks(command)).toBe(false);
	});

	it.each([
		"git -C /repo reset --hard",
		"git --git-dir /repo/.git reset --hard",
		"git --work-tree /repo --namespace name restore file",
		"git --git-dir=/repo/.git add file",
		"git --config-env user.name=NAME --super-prefix /repo/ commit -m x",
	])("skips git global options: %s", (command) => {
		expect(blocks(command)).toBe(true);
	});

	it.each([
		"bun run check-types",
		"npm run check",
		"pnpm run check",
		"yarn run check",
		"bun --cwd /repo run check",
		"npm --prefix /repo run check",
		"make check",
		"just check",
		"task check",
		"bash -c 'bun run check-types'",
		"eval 'make check'",
		"find . -exec just check \\;",
	])("requires approval without blocking package scripts: %s", (command) => {
		expect(blocks(command)).toBe(false);
		expect(requiresPlanModeCommandApproval(command)).toBe(true);
	});

	it("inspects structured shell argv recursively and requires script approval", () => {
		expect(
			findFileEditingCommand({ command: "bash", args: ["-c", "touch file"] }),
		).toBe("`touch`");
		expect(
			findFileEditingCommand({
				command: "node",
				args: ["-e", "console.log(1)"],
			}),
		).toContain("inline code");
		expect(
			requiresPlanModeCommandApproval({
				command: "bun",
				args: ["run", "check-types"],
			}),
		).toBe(true);
		expect(
			findFileEditingCommand({ command: "bun", args: ["run", "check-types"] }),
		).toBeUndefined();
		expect(requiresPlanModeCommandApproval("git status")).toBe(false);
		expect(requiresPlanModeCommandApproval('echo "bun run check-types"')).toBe(
			false,
		);
	});
});

describe("formatPlanModeBlockedCommandError", () => {
	it("names the offending construct and the plan-mode contract", () => {
		const message = formatPlanModeBlockedCommandError("`rm`");
		expect(message).toContain("`rm`");
		expect(message).toContain("PLAN MODE");
		expect(message).toContain("not executed");
		expect(message).toContain("act mode");
	});
});
