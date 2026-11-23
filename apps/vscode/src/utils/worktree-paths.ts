import { realpath as fsRealpath } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"

const nativeRealpath = promisify(fsRealpath.native)

export function worktreePaths(platform = process.platform, realpath: (file: string) => Promise<string> = nativeRealpath) {
	const paths = platform === "win32" ? path.win32 : path.posix
	async function canonical(file: string): Promise<string> {
		try {
			return paths.normalize(await realpath(file))
		} catch (error) {
			const { code } = error as NodeJS.ErrnoException
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error
			// Git keeps registered worktree paths even when their folders are missing.
			const parent = paths.dirname(file)
			return parent === file ? file : paths.join(await canonical(parent), paths.basename(file))
		}
	}
	const key = (file: string) => canonical(paths.resolve(file))
	function isInside(base: string, child: string) {
		const parent = paths.resolve(base)
		const nested = paths.resolve(child)
		return nested !== parent && nested.startsWith(parent.endsWith(paths.sep) ? parent : parent + paths.sep)
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
