#!/usr/bin/env node

/**
 * Package the fork as a separate extension that installs side by side with the
 * Marketplace Cline (saoudrizwan.claude-dev).
 *
 * Same approach as publish-nightly.mjs: rewrite package.json to a new identity
 * before `vsce package` (whose vscode:prepublish build bakes the manifest's
 * name into command and view IDs via src/registry.ts), then restore it.
 *
 * Usage: bun run package:fork   (writes <repo>/cliner-<version>.vsix)
 */

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, "..")
const repoRoot = path.resolve(projectRoot, "../..")
const packageJsonPath = path.join(projectRoot, "package.json")

const FORK_NAME = "cliner"
const FORK_DISPLAY_NAME = "Cline (Fork)"

const original = fs.readFileSync(packageJsonPath, "utf-8")

function writeForkManifest() {
	// Command IDs ("cline.*") and view/container IDs ("claude-dev*") must not
	// collide with the Marketplace extension's contributions.
	const pkg = JSON.parse(original.replaceAll("claude-dev", FORK_NAME).replaceAll('"cline.', `"${FORK_NAME}.`))
	pkg.name = FORK_NAME
	pkg.displayName = FORK_DISPLAY_NAME
	for (const container of pkg.contributes.viewsContainers.activitybar) {
		container.title = FORK_DISPLAY_NAME
	}
	fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, "\t"))
	return pkg
}

let restored = false
function restore() {
	if (!restored) {
		fs.writeFileSync(packageJsonPath, original)
		restored = true
	}
}
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		restore()
		process.exit(1)
	})
}

try {
	const pkg = writeForkManifest()
	const out = path.join(repoRoot, `${FORK_NAME}-${pkg.version}.vsix`)
	console.log(`Packaging ${pkg.publisher}.${pkg.name}@${pkg.version} -> ${out}`)
	execFileSync(
		path.join(projectRoot, "node_modules/.bin/vsce"),
		["package", "--no-dependencies", "--allow-package-secrets", "sendgrid", "--out", out],
		{ cwd: projectRoot, stdio: "inherit" },
	)
} finally {
	restore()
}
