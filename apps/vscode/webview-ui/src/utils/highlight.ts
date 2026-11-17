/** Sorts and merges overlapping or adjacent inclusive `[start, end]` regions. */
export const mergeHighlightRegions = (regions: [number, number][]): [number, number][] => {
	if (regions.length === 0) {
		return regions
	}

	// Sort regions by start index
	regions.sort((a, b) => a[0] - b[0])

	const merged: [number, number][] = [regions[0]]

	for (let i = 1; i < regions.length; i++) {
		const last = merged[merged.length - 1]
		const current = regions[i]

		if (current[0] <= last[1] + 1) {
			// Overlapping or adjacent regions
			last[1] = Math.max(last[1], current[1])
		} else {
			merged.push(current)
		}
	}

	return merged
}

/** Inclusive regions of every case-insensitive occurrence of `query` in `text`, merged. */
export const findSubstringRegions = (text: string, query: string): [number, number][] => {
	const needle = query.trim().toLowerCase()
	if (!needle) return []
	const haystack = text.toLowerCase()
	const regions: [number, number][] = []
	let index = haystack.indexOf(needle)
	while (index !== -1) {
		regions.push([index, index + needle.length - 1])
		index = haystack.indexOf(needle, index + needle.length)
	}
	return mergeHighlightRegions(regions)
}
