// From webview-ui:
// bun build scripts/profile-large-code-block.tsx --target=node --format=cjs --external react --external react-dom --external styled-components --outdir=tmp/profile-code
// cp tmp/profile-code/profile-large-code-block.js tmp/profile-code/profile-large-code-block.cjs
// node --cpu-prof --cpu-prof-dir=../../../tmp/large-edit-profile tmp/profile-code/profile-large-code-block.cjs --large
import { performance } from "node:perf_hooks"
import { renderToStaticMarkup } from "react-dom/server"
import CodeBlock from "../src/components/common/CodeBlock"

const lines = process.argv.includes("--large") ? 20_000 : 2_500
const source = `\`\`\`typescript\n${Array.from({ length: lines }, (_, i) => `const value_${i} = { message: "${"x".repeat(80)}", enabled: true };`).join("\n")}\n\`\`\``
const started = performance.now()
const html = renderToStaticMarkup(<CodeBlock source={source} />)
console.log(
	JSON.stringify({
		lines,
		sourceCharacters: source.length,
		htmlCharacters: html.length,
		elapsedMs: performance.now() - started,
	}),
)
