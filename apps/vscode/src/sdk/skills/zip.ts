import { deflateRawSync, inflateRawSync } from "node:zlib"

// A small zip reader and writer over Node's zlib, for skillsets. The reader
// trusts nothing in the file: it reads only the central directory, refuses
// paths that leave the folder, links, encrypted or zip64 entries, and stops
// at size and count limits before inflating anything.

export interface ZipEntry {
	/** Forward-slash path inside the zip, never absolute and never with `..`. */
	path: string
	data: Buffer
	/** Unix permission bits when the zip recorded them (0 otherwise). */
	mode: number
}

export interface ZipLimits {
	maxEntries: number
	maxEntryBytes: number
	maxTotalBytes: number
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
	maxEntries: 400,
	maxEntryBytes: 2 * 1024 * 1024,
	maxTotalBytes: 20 * 1024 * 1024,
}

export class ZipError extends Error {}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const S_IFMT = 0o170000
const S_IFLNK = 0o120000
const S_IFDIR = 0o040000

/** Rejects absolute paths, drive letters, `..` and empty segments; returns the normalized path. */
export function safeZipPath(raw: string): string {
	const name = raw.replace(/\\/g, "/")
	if (!name || name.startsWith("/") || /^[a-zA-Z]:/.test(name) || name.includes("\0")) {
		throw new ZipError(`Unsafe path in zip: ${raw}`)
	}
	const parts = name.split("/")
	const trailingSlash = parts.at(-1) === ""
	const segments = trailingSlash ? parts.slice(0, -1) : parts
	for (const segment of segments) {
		if (!segment || segment === "." || segment === "..") throw new ZipError(`Unsafe path in zip: ${raw}`)
	}
	return segments.join("/") + (trailingSlash ? "/" : "")
}

function findEndOfCentralDirectory(buffer: Buffer): number {
	// The record is 22 bytes plus a comment of up to 65535 bytes.
	const stop = Math.max(0, buffer.length - 22 - 0xffff)
	for (let offset = buffer.length - 22; offset >= stop; offset--) {
		if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
	}
	throw new ZipError("This isn't a zip file.")
}

/** Reads every file in a zip. Directories are skipped; anything unsafe throws a ZipError. */
export function readZip(buffer: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
	if (buffer.length < 22) throw new ZipError("This isn't a zip file.")
	const eocd = findEndOfCentralDirectory(buffer)
	const count = buffer.readUInt16LE(eocd + 10)
	const directorySize = buffer.readUInt32LE(eocd + 12)
	const directoryOffset = buffer.readUInt32LE(eocd + 16)
	if (count === 0xffff || directoryOffset === 0xffffffff) throw new ZipError("Zip64 files aren't supported.")
	if (count > limits.maxEntries) throw new ZipError(`It has ${count} files; a skillset can have at most ${limits.maxEntries}.`)
	if (directoryOffset + directorySize > buffer.length) throw new ZipError("The zip is damaged.")

	const entries: ZipEntry[] = []
	const seen = new Set<string>()
	let total = 0
	let offset = directoryOffset
	for (let index = 0; index < count; index++) {
		if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
			throw new ZipError("The zip is damaged.")
		}
		const madeBy = buffer.readUInt16LE(offset + 4) >> 8
		const flags = buffer.readUInt16LE(offset + 8)
		const method = buffer.readUInt16LE(offset + 10)
		const compressedSize = buffer.readUInt32LE(offset + 20)
		const size = buffer.readUInt32LE(offset + 24)
		const nameLength = buffer.readUInt16LE(offset + 28)
		const extraLength = buffer.readUInt16LE(offset + 30)
		const commentLength = buffer.readUInt16LE(offset + 32)
		const externalAttributes = buffer.readUInt32LE(offset + 38)
		const localOffset = buffer.readUInt32LE(offset + 42)
		const rawName = buffer.toString(flags & 0x800 ? "utf8" : "latin1", offset + 46, offset + 46 + nameLength)
		offset += 46 + nameLength + extraLength + commentLength

		const name = safeZipPath(rawName)
		// Unix zips keep st_mode in the high 16 bits of the external attributes.
		const mode = madeBy === 3 ? externalAttributes >>> 16 : 0
		if ((mode & S_IFMT) === S_IFLNK) throw new ZipError(`Links aren't allowed in a skillset: ${name}`)
		if (name.endsWith("/") || (mode & S_IFMT) === S_IFDIR) continue
		if (flags & 0x1) throw new ZipError(`Encrypted files aren't supported: ${name}`)
		if (size === 0xffffffff || compressedSize === 0xffffffff) throw new ZipError("Zip64 files aren't supported.")
		if (size > limits.maxEntryBytes) {
			throw new ZipError(
				`${name} is ${formatBytes(size)}; files in a skillset can be at most ${formatBytes(limits.maxEntryBytes)}.`,
			)
		}
		total += size
		if (total > limits.maxTotalBytes) {
			throw new ZipError(`It unpacks to more than ${formatBytes(limits.maxTotalBytes)}.`)
		}
		const key = name.toLowerCase()
		if (seen.has(key)) throw new ZipError(`The zip lists ${name} twice.`)
		seen.add(key)

		if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
			throw new ZipError("The zip is damaged.")
		}
		const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28)
		if (dataStart + compressedSize > buffer.length) throw new ZipError("The zip is damaged.")
		const compressed = buffer.subarray(dataStart, dataStart + compressedSize)
		let data: Buffer
		if (method === 0) {
			data = Buffer.from(compressed)
		} else if (method === 8) {
			try {
				// The declared size can lie: never inflate past it (or the limit).
				data = inflateRawSync(compressed, { maxOutputLength: Math.max(1, Math.min(size, limits.maxEntryBytes)) })
			} catch {
				throw new ZipError(`Couldn't unpack ${name}.`)
			}
		} else {
			throw new ZipError(`${name} uses a compression this reader doesn't support.`)
		}
		if (data.length !== size) throw new ZipError(`${name} is damaged.`)
		entries.push({ path: name, data, mode: mode & 0o7777 })
	}
	return entries
}

let crcTable: Uint32Array | undefined
function crc32(data: Buffer): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256)
		for (let n = 0; n < 256; n++) {
			let c = n
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
			crcTable[n] = c >>> 0
		}
	}
	let crc = 0xffffffff
	for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
	return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date: Date): { time: number; date: number } {
	const year = Math.max(1980, date.getFullYear())
	return {
		time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
		date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
	}
}

/** Writes a zip (deflated, UTF-8 names, Unix modes kept so scripts stay executable). */
export function writeZip(files: { path: string; data: Buffer; mode?: number }[], now = new Date()): Buffer {
	const locals: Buffer[] = []
	const centrals: Buffer[] = []
	const stamp = dosDateTime(now)
	let offset = 0
	for (const file of files) {
		const name = Buffer.from(safeZipPath(file.path), "utf8")
		const compressed = deflateRawSync(file.data)
		const stored = compressed.length >= file.data.length
		const body = stored ? file.data : compressed
		const crc = crc32(file.data)

		const local = Buffer.alloc(30)
		local.writeUInt32LE(LOCAL_SIGNATURE, 0)
		local.writeUInt16LE(20, 4)
		local.writeUInt16LE(0x800, 6)
		local.writeUInt16LE(stored ? 0 : 8, 8)
		local.writeUInt16LE(stamp.time, 10)
		local.writeUInt16LE(stamp.date, 12)
		local.writeUInt32LE(crc, 14)
		local.writeUInt32LE(body.length, 18)
		local.writeUInt32LE(file.data.length, 22)
		local.writeUInt16LE(name.length, 26)
		locals.push(local, name, body)

		const central = Buffer.alloc(46)
		central.writeUInt32LE(CENTRAL_SIGNATURE, 0)
		central.writeUInt16LE((3 << 8) | 20, 4)
		central.writeUInt16LE(20, 6)
		central.writeUInt16LE(0x800, 8)
		central.writeUInt16LE(stored ? 0 : 8, 10)
		central.writeUInt16LE(stamp.time, 12)
		central.writeUInt16LE(stamp.date, 14)
		central.writeUInt32LE(crc, 16)
		central.writeUInt32LE(body.length, 20)
		central.writeUInt32LE(file.data.length, 24)
		central.writeUInt16LE(name.length, 28)
		central.writeUInt32LE((((file.mode ?? 0o644) & 0o7777) | 0o100000) * 0x10000, 38)
		central.writeUInt32LE(offset, 42)
		centrals.push(central, name)
		offset += 30 + name.length + body.length
	}
	const directory = Buffer.concat(centrals)
	const end = Buffer.alloc(22)
	end.writeUInt32LE(EOCD_SIGNATURE, 0)
	end.writeUInt16LE(files.length, 8)
	end.writeUInt16LE(files.length, 10)
	end.writeUInt32LE(directory.length, 12)
	end.writeUInt32LE(offset, 16)
	return Buffer.concat([...locals, directory, end])
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`
}
