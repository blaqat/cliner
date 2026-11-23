import { promises as fs } from "node:fs"
import path from "node:path"

export function worktreePaths(platform = process.platform, realpath: (file: string) => Promise<string> = fs.realpath) {
	const paths = platform === "win32" ? path.win32 : path.posix
	const ignoreCase = platform === "win32" || platform === "darwin"
	const fold = (file: string) => (ignoreCase ? file.toLowerCase() : file)
	async function canonical(file: string): Promise<string> {
		try {
			return await realpath(file)
		} catch (error) {
			const { code } = error as NodeJS.ErrnoException
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error
			// Git keeps registered worktree paths even when their folders are missing.
			const parent = paths.dirname(file)
			return parent === file ? file : paths.join(await canonical(parent), paths.basename(file))
		}
	}
	const key = async (file: string) => fold(await canonical(paths.resolve(file)))
	function isInside(base: string, child: string) {
		const relative = paths.relative(fold(base), fold(child))
		return !!relative && relative !== ".." && !relative.startsWith(".." + paths.sep) && !paths.isAbsolute(relative)
	}
	return {
		key,
		async same(a: string, b: string) {
			const [left, right] = await Promise.all([key(a), key(b)])
			return left === right
		},
		isInside,
		async inside(base: string, child: string) {
			const [parent, nested] = await Promise.all([key(base), key(child)])
			return isInside(parent, nested)
		},
	}
}

export const worktreePath = worktreePaths()
