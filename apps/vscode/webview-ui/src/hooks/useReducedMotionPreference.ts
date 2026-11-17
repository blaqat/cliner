import { useReducedMotion } from "framer-motion"

/** True under the OS reduced-motion setting or VS Code's workbench.reduceMotion (body class). */
export function useReducedMotionPreference(): boolean {
	const prefersReduced = useReducedMotion()
	return !!prefersReduced || (typeof document !== "undefined" && document.body.classList.contains("vscode-reduce-motion"))
}
