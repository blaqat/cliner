import { EmptyRequest } from "@shared/proto/cline/common"
import { ImportSkillsetRequest } from "@shared/proto/cline/skillset"
import { SKILLSET_MAX_DROP_BYTES, type SkillsetImportResult } from "@shared/skillsets"
import { SkillsetServiceClient } from "@/services/grpc-client"
import { addSkillsetToast, setEatPhase } from "./skillsetStore"

/** How long each beat of the moment lasts (the mock's timing); reduced motion skips the chewing. */
export const EAT_MS = 900
export const SPARK_MS = 1500
const SHAKE_MS = 600

let run = 0
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function parseImportResult(json: string): SkillsetImportResult {
	try {
		const parsed = JSON.parse(json) as SkillsetImportResult
		return parsed && typeof parsed === "object"
			? parsed
			: { fileName: "", skills: 0, workflows: 0, alreadyHad: 0, error: "No answer." }
	} catch {
		return { fileName: "", skills: 0, workflows: 0, alreadyHad: 0, error: "No answer." }
	}
}

/**
 * Plays the moment around an import: the logo chews while the host unzips and
 * checks, then sparkles (or shakes its head) and the toast says what arrived.
 * The toast comes in as the sparkle settles, so it never covers it.
 */
export async function playSkillsetImport(
	importing: Promise<SkillsetImportResult>,
	options: { still: boolean; chew?: boolean },
): Promise<SkillsetImportResult> {
	const mine = ++run
	const chew = options.chew !== false
	if (chew) setEatPhase("eating")
	let result: SkillsetImportResult
	try {
		;[result] = await Promise.all([importing, chew && !options.still ? wait(EAT_MS) : Promise.resolve()])
	} catch (error) {
		result = {
			fileName: "",
			skills: 0,
			workflows: 0,
			alreadyHad: 0,
			error: error instanceof Error ? error.message : String(error),
		}
	}
	if (mine !== run) return result
	if (result.cancelled) {
		setEatPhase("idle")
		return result
	}
	if (result.error) {
		setEatPhase("shake")
		addSkillsetToast(result)
		await wait(options.still ? 1200 : SHAKE_MS)
	} else if (result.set) {
		// The toast waits for the sparkle to finish, so it never covers the moment.
		setEatPhase("spark")
		await wait(options.still ? 1600 : SPARK_MS)
		if (mine === run) addSkillsetToast(result)
	} else {
		addSkillsetToast(result)
	}
	if (mine === run) setEatPhase("idle")
	return result
}

function readAsBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""))
		reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the file."))
		reader.readAsDataURL(file)
	})
}

/** A file dropped from the OS: its bytes go to the host (capped). */
export function importDroppedFile(file: File, still: boolean): Promise<SkillsetImportResult> {
	if (file.size > SKILLSET_MAX_DROP_BYTES) {
		return playSkillsetImport(
			Promise.resolve({
				fileName: file.name,
				skills: 0,
				workflows: 0,
				alreadyHad: 0,
				error: "It's bigger than 20 MB, too big to drop. Use Skills › Add skillset… instead.",
			}),
			{ still },
		)
	}
	return playSkillsetImport(
		readAsBase64(file).then(async (dataBase64) =>
			parseImportResult(
				(await SkillsetServiceClient.importSkillset(ImportSkillsetRequest.create({ fileName: file.name, dataBase64 })))
					.json,
			),
		),
		{ still },
	)
}

/** A file dragged from VS Code's Explorer: the host reads it from its path. */
export function importDroppedUri(uri: string, still: boolean): Promise<SkillsetImportResult> {
	const fileName = decodeURIComponent(uri.split(/[\\/]/).pop() ?? uri)
	return playSkillsetImport(
		SkillsetServiceClient.importSkillset(ImportSkillsetRequest.create({ fileName, uri })).then((response) =>
			parseImportResult(response.json),
		),
		{ still },
	)
}

/** Skills › Add skillset…: VS Code's open dialog; the logo plays only once a file was picked. */
export async function pickSkillset(still: boolean): Promise<SkillsetImportResult> {
	const result = parseImportResult((await SkillsetServiceClient.pickSkillset(EmptyRequest.create())).json)
	if (result.cancelled) return result
	return playSkillsetImport(Promise.resolve(result), { still, chew: false })
}
