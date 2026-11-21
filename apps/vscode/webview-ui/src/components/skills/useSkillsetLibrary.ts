import { ListSkillsetLibraryRequest } from "@shared/proto/cline/skillset"
import type { SkillsetLibrary } from "@shared/skillsets"
import { useCallback, useEffect, useRef, useState } from "react"
import { SkillsetServiceClient } from "@/services/grpc-client"

/**
 * Skills and workflows with their files, plus the added sets. Polls while
 * mounted (like the Skills tab does) so turning things on elsewhere shows here.
 */
export function useSkillsetLibrary(options: { includeFiles: boolean; pollMs?: number; enabled?: boolean }) {
	const [library, setLibrary] = useState<SkillsetLibrary>()
	const [error, setError] = useState<string>()
	const alive = useRef(true)
	const refresh = useCallback(async () => {
		try {
			const response = await SkillsetServiceClient.listSkillsetLibrary(
				ListSkillsetLibraryRequest.create({ includeFiles: options.includeFiles }),
			)
			if (!alive.current) return
			setLibrary(JSON.parse(response.json) as SkillsetLibrary)
			setError(undefined)
		} catch (error) {
			if (alive.current) setError(error instanceof Error ? error.message : String(error))
		}
	}, [options.includeFiles])
	const enabled = options.enabled !== false
	useEffect(() => {
		alive.current = true
		if (!enabled) return
		void refresh()
		const timer = options.pollMs ? setInterval(() => void refresh(), options.pollMs) : undefined
		return () => {
			alive.current = false
			if (timer) clearInterval(timer)
		}
	}, [refresh, options.pollMs, enabled])
	return { library, error, refresh }
}
