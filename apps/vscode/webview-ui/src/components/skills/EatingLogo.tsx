import { useId } from "react"
import { cn } from "@/lib/utils"
import "./skillset.css"

/** What the logo is doing: resting, mouth open over a dragged skillset, chewing, sparkle eyes, or shaking its head. */
export type EatPhase = "idle" | "over" | "eating" | "spark" | "shake"

/** ClineLogoVariable's outline; split at the mouth line so the jaw can drop. */
const LOGO_PATH =
	"M56.4998 8.99805L56.4999 5.29805H56.4998V8.99805ZM68.4998 20.708L72.1998 20.7081V20.708H68.4998ZM67.9929 25L64.3662 24.2671L63.4704 28.7H67.9929V25ZM84.4998 25L84.4998 21.3H84.4998V25ZM95.7 49.7998H92V51.2066L92.9346 52.258L95.7 49.7998ZM108.027 63.667L110.793 61.2088L110.792 61.2088L108.027 63.667ZM108.027 64.7305L110.792 67.1887L110.793 67.1883L108.027 64.7305ZM95.7 78.5977L92.9346 76.1394L92 77.1909V78.5977H95.7ZM95.7 92.2002L99.3999 92.2002V92.2002H95.7ZM84.4998 103.4V107.1H84.4998L84.4998 103.4ZM17.2996 92.2002H13.5996V92.2002L17.2996 92.2002ZM17.2996 78.5986H20.9996V77.1918L20.0649 76.1404L17.2996 78.5986ZM4.97144 64.7305L2.20602 67.1886L2.20611 67.1887L4.97144 64.7305ZM4.97144 63.667L7.73685 66.1251L7.73685 66.1251L4.97144 63.667ZM17.2996 49.7979L20.065 52.256L20.9996 51.2046V49.7979H17.2996ZM45.0066 25V28.7H49.5292L48.6333 24.267L45.0066 25ZM44.4998 20.708H40.7998V20.7081L44.4998 20.708ZM56.4998 8.99805L56.4996 12.698C61.1812 12.6982 64.7998 16.3247 64.7998 20.708H68.4998H72.1998C72.1998 12.0452 65.0728 5.29829 56.4999 5.29805L56.4998 8.99805ZM68.4998 20.708L64.7998 20.7079C64.7997 21.6154 64.6614 22.8066 64.3662 24.2671L67.9929 25L71.6196 25.7329C71.969 24.004 72.1997 22.2864 72.1998 20.7081L68.4998 20.708ZM67.9929 25V28.7H84.4998V25V21.3H67.9929V25ZM84.4998 25L84.4997 28.7C88.6419 28.7001 92 32.0582 92 36.2002H95.7H99.3999C99.3999 27.9712 92.7287 21.3001 84.4998 21.3L84.4998 25ZM95.7 36.2002H92V49.7998H95.7H99.3999V36.2002H95.7ZM95.7 49.7998L92.9346 52.258L105.262 66.1252L108.027 63.667L110.792 61.2088L98.4653 47.3416L95.7 49.7998ZM108.027 63.667L105.262 66.1251C104.285 65.026 104.285 63.371 105.261 62.2727L108.027 64.7305L110.793 67.1883C112.308 65.4837 112.308 62.9141 110.793 61.2088L108.027 63.667ZM108.027 64.7305L105.262 62.2722L92.9346 76.1394L95.7 78.5977L98.4653 81.0559L110.792 67.1887L108.027 64.7305ZM95.7 78.5977H92V92.2002H95.7H99.3999V78.5977H95.7ZM95.7 92.2002L92 92.2002C91.9999 96.3422 88.6418 99.7003 84.4997 99.7004L84.4998 103.4L84.4998 107.1C92.7287 107.1 99.3999 100.429 99.3999 92.2002L95.7 92.2002ZM84.4998 103.4V99.7004H28.4998V103.4V107.1H84.4998V103.4ZM28.4998 103.4V99.7004C24.3577 99.7004 20.9996 96.3423 20.9996 92.2002L17.2996 92.2002L13.5996 92.2002C13.5996 100.429 20.2707 107.1 28.4998 107.1V103.4ZM17.2996 92.2002H20.9996V78.5986H17.2996H13.5996V92.2002H17.2996ZM17.2996 78.5986L20.0649 76.1404L7.73676 62.2722L4.97144 64.7305L2.20611 67.1887L14.5342 81.0569L17.2996 78.5986ZM4.97144 64.7305L7.73685 62.2723C8.71353 63.3711 8.71353 65.0264 7.73685 66.1251L4.97144 63.667L2.20602 61.2088C0.690476 62.9138 0.690476 65.4836 2.20602 67.1886L4.97144 64.7305ZM4.97144 63.667L7.73685 66.1251L20.065 52.256L17.2996 49.7979L14.5341 47.3397L2.20602 61.2088L4.97144 63.667ZM17.2996 49.7979H20.9996V36.2002H17.2996H13.5996V49.7979H17.2996ZM17.2996 36.2002H20.9996C20.9996 32.0581 24.3576 28.7 28.4998 28.7V25V21.3C20.2707 21.3 13.5996 27.9712 13.5996 36.2002H17.2996ZM28.4998 25V28.7H45.0066V25V21.3H28.4998V25ZM45.0066 25L48.6333 24.267C48.3381 22.8066 48.1998 21.6154 48.1998 20.7079L44.4998 20.708L40.7998 20.7081C40.7998 22.2864 41.0305 24.0039 41.3799 25.733L45.0066 25ZM44.4998 20.708H48.1998C48.1998 16.3244 51.8182 12.698 56.4998 12.698V8.99805V5.29805C47.9264 5.29805 40.7998 12.0451 40.7998 20.708H44.4998Z"
const STAR = "M0 -12C1.4 -4 4 -1.4 12 0C4 1.4 1.4 4 0 12C-1.4 4 -4 1.4 -12 0C-4 -1.4 -1.4 -4 0 -12Z"
const STAR_SMALL = "M0 -7C0.8 -2.3 2.3 -0.8 7 0C2.3 0.8 0.8 2.3 0 7C-0.8 2.3 -2.3 0.8 -7 0C-2.3 -0.8 -0.8 -2.3 0 -7Z"
const TWINKLES: [number, number, "a" | "b", string][] = [
	[-2, 30, "a", "0s"],
	[112, 22, "b", ".25s"],
	[118, 92, "a", ".5s"],
	[-8, 98, "b", ".15s"],
	[56, -8, "a", ".4s"],
]

const PHASE_CLASS: Record<EatPhase, string> = {
	idle: "",
	over: "is-open",
	eating: "is-eat",
	spark: "is-spark",
	shake: "is-shake",
}

/**
 * The Cline logo that eats skillsets: the jaw drops while one is dragged over,
 * it chews on drop, and its eyes turn into sparkles in the theme's yellow.
 * `still` is the reduced-motion version: no movement, the same end states.
 * Always the plain logo (never the December Santa one) so the jaw lines up.
 */
export function EatingLogo({
	phase,
	still,
	className,
	label = "Cline",
}: {
	phase: EatPhase
	still?: boolean
	className?: string
	label?: string
}) {
	const id = useId().replace(/[^a-zA-Z0-9_-]/g, "")
	return (
		<svg
			aria-label={label}
			className={cn("cline-eat", PHASE_CLASS[phase], still && "is-still", className)}
			data-phase={phase}
			data-testid="eating-logo"
			role="img"
			viewBox="0 0 113 113">
			<defs>
				<clipPath id={`${id}-top`}>
					<rect height="114" width="173" x="-30" y="-30" />
				</clipPath>
				<clipPath id={`${id}-jaw`}>
					<rect height="60" width="173" x="-30" y="84" />
				</clipPath>
			</defs>
			<g className="body">
				<g clipPath={`url(#${id}-top)`}>
					<path className="o" d={LOGO_PATH} />
				</g>
				<rect className="gap" height="13" width="71" x="21" y="84" />
				<rect className="wall" height="13.6" width="7.4" x="13.6" y="83.6" />
				<rect className="wall" height="13.6" width="7.4" x="92" y="83.6" />
				<g className="jaw">
					<g clipPath={`url(#${id}-jaw)`}>
						<path className="o" d={LOGO_PATH} />
					</g>
				</g>
				<rect className="eye" height="28.8" rx="4.8" width="9.6" x="37.3" y="49.8" />
				<rect className="eye" height="28.8" rx="4.8" width="9.6" x="66.1" y="49.8" />
				<g transform="translate(42.1 64.2)">
					<path className="spk" d={STAR} />
				</g>
				<g transform="translate(70.9 64.2)">
					<path className="spk" d={STAR} />
				</g>
			</g>
			{TWINKLES.map(([x, y, size, delay]) => (
				<g key={`${x}-${y}`} transform={`translate(${x} ${y})`}>
					<path className={`twk ${size}`} d={STAR_SMALL} style={{ animationDelay: delay }} />
				</g>
			))}
			<g transform="translate(56.5 90)">
				<g className="morsel">
					<path className="mz" d="M-10 -13h13l7 7v19h-20z" />
					<path className="mzz" d="M-3 -11v3M-3 -5v3M-3 1v3" fill="none" />
				</g>
			</g>
		</svg>
	)
}
