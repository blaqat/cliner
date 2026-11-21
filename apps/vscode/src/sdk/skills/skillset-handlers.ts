import { SKILLSET_MAX_DROP_BYTES, type SkillItemKind, type SkillsetImportResult } from "@shared/skillsets"
import { existsSync } from "fs"
import * as fs from "fs/promises"
import os from "os"
import * as path from "path"
import * as vscode from "vscode"
import type { Controller } from "@/core/controller"
import { HostProvider } from "@/hosts/host-provider"
import { revealInOs } from "@/hosts/vscode/skillsets/revealInOs"
import { Logger } from "@/shared/services/Logger"
import { exportSkillset, importSkillset, listSkillsetLibrary, skillsetFileName, updateSkillsetItems } from "./skillset-service"
import { vscodeSkillsetEnvironment } from "./vscode-skillset-env"

type Listener = (result: SkillsetImportResult) => Promise<void> | void

const listeners = new Set<Listener>()
/** An import from the command palette may finish before the panel subscribes: it's kept briefly and replayed. */
let unseen: { result: SkillsetImportResult; at: number } | undefined

export function addSkillsetImportListener(listener: Listener): () => void {
	listeners.add(listener)
	if (unseen && Date.now() - unseen.at < 15_000) {
		const { result } = unseen
		unseen = undefined
		void listener(result)
	}
	return () => listeners.delete(listener)
}

function broadcast(result: SkillsetImportResult): void {
	if (!listeners.size) {
		unseen = { result, at: Date.now() }
		return
	}
	for (const listener of listeners) {
		Promise.resolve(listener(result)).catch((error) =>
			Logger.warn("[Skillsets] Couldn't tell the panel about an import:", error),
		)
	}
}

async function afterChange(controller: Controller): Promise<void> {
	await controller.postStateToWebview()
}

/** A drop: the bytes of an OS file, or a path the Explorer gave. */
export async function importDroppedSkillset(
	controller: Controller,
	input: { fileName: string; dataBase64?: string; uri?: string },
): Promise<SkillsetImportResult> {
	let buffer: Buffer
	let fileName = input.fileName
	if (input.uri) {
		const filePath =
			input.uri.startsWith("file:") || input.uri.includes("://") ? vscode.Uri.parse(input.uri).fsPath : input.uri
		fileName = path.basename(filePath)
		const stat = await fs.stat(filePath).catch(() => undefined)
		if (!stat?.isFile()) return { fileName, skills: 0, workflows: 0, alreadyHad: 0, error: "That file can't be read." }
		if (stat.size > SKILLSET_MAX_DROP_BYTES) {
			return { fileName, skills: 0, workflows: 0, alreadyHad: 0, error: "It's bigger than 20 MB, too big for a skillset." }
		}
		buffer = await fs.readFile(filePath)
	} else {
		buffer = Buffer.from(input.dataBase64 ?? "", "base64")
		if (buffer.length > SKILLSET_MAX_DROP_BYTES) {
			return { fileName, skills: 0, workflows: 0, alreadyHad: 0, error: "It's bigger than 20 MB, too big for a skillset." }
		}
	}
	const result = await importSkillset(await vscodeSkillsetEnvironment(controller), buffer, fileName)
	if (result.set) await afterChange(controller)
	return result
}

/** Add skillset…: VS Code's open dialog, then the same import. */
export async function pickAndImportSkillset(controller: Controller): Promise<SkillsetImportResult> {
	const picked = await HostProvider.window.showOpenDialogue({
		canSelectMany: false,
		openLabel: "Add skillset",
		filters: { files: ["zip"] },
	})
	const file = picked.paths?.[0]
	if (!file) return { fileName: "", skills: 0, workflows: 0, alreadyHad: 0, cancelled: true }
	return importDroppedSkillset(controller, { fileName: path.basename(file), uri: file })
}

/** The Cline: Add skillset command: shows the panel, then imports and lets the panel play the moment. */
export async function runAddSkillsetCommand(controller: Controller, focusPanel: () => Promise<unknown>): Promise<void> {
	const result = await pickAndImportSkillset(controller)
	if (result.cancelled) return
	await focusPanel()
	broadcast(result)
}

export async function listLibrary(controller: Controller, includeFiles: boolean) {
	return listSkillsetLibrary(await vscodeSkillsetEnvironment(controller), { includeFiles })
}

export async function updateItems(
	controller: Controller,
	input: { setId: string; action: string; paths: string[] },
): Promise<void> {
	if (!["turn_on", "remove", "seen"].includes(input.action)) throw new Error(`Unknown action: ${input.action}`)
	await updateSkillsetItems(await vscodeSkillsetEnvironment(controller), {
		setId: input.setId,
		action: input.action as "turn_on" | "remove" | "seen",
		paths: input.paths,
	})
	await afterChange(controller)
}

/** Save skillset…: the save dialog (Downloads first), then the zip. */
export async function saveSkillset(
	controller: Controller,
	input: { name: string; description: string; items: { kind: SkillItemKind; path: string }[] },
) {
	const name = input.name.trim()
	if (!name) throw new Error("Name the skillset first.")
	const downloads = path.join(os.homedir(), "Downloads")
	const folder = existsSync(downloads) ? downloads : os.homedir()
	const { selectedPath } = await HostProvider.window.showSaveDialog({
		options: {
			defaultPath: path.join(folder, skillsetFileName(name)),
			filters: { Skillsets: { extensions: ["zip"] } },
		},
	})
	if (!selectedPath) return { cancelled: true }
	const env = await vscodeSkillsetEnvironment(controller)
	const result = await exportSkillset(
		input.items,
		{ name, description: input.description.trim() || undefined, appVersion: env.appVersion },
		selectedPath,
	)
	const dir = path.dirname(selectedPath)
	return { ...result, folder: dir.startsWith(os.homedir()) ? `~${dir.slice(os.homedir().length)}` : dir }
}

export async function revealSkillset(filePath: string): Promise<void> {
	if (!filePath || !existsSync(filePath)) throw new Error("That file was moved or deleted.")
	await revealInOs(filePath)
}
