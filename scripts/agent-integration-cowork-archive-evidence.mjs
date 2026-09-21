import fs from 'node:fs'

const MAX_ARCHIVE_BYTES = 1024 * 1024
const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const MAX_ZIP_COMMENT_BYTES = 0xffff
const EXPECTED_FLAGS = 0x0800
const EXPECTED_EXTERNAL_ATTRIBUTES = (0o100600 << 16) >>> 0

export function verifyCoworkPluginArchive({ pluginPath, expectedArchive, expectedEntries }) {
  if (!fs.statSync(pluginPath).isFile()) throw new Error(`Cowork plugin is not a regular file: ${pluginPath}`)
  const onDisk = fs.readFileSync(pluginPath)
  if (onDisk.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`Cowork plugin archive exceeds the ${MAX_ARCHIVE_BYTES}-byte verification limit`)
  }

  const entries = readStoredZipEntries(onDisk)
  const actualNames = entries.map(entry => entry.name).sort()
  const expectedNames = Object.keys(expectedEntries).sort()
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`Cowork plugin entries differ: ${JSON.stringify(actualNames)}`)
  }

  for (const name of expectedNames) {
    const entry = entries.find(candidate => candidate.name === name)
    if (!entry) throw new Error(`Cowork plugin entry could not be extracted: ${name}`)
    const expected = Buffer.isBuffer(expectedEntries[name])
      ? expectedEntries[name]
      : Buffer.from(expectedEntries[name], 'utf8')
    if (!entry.body.equals(expected)) throw new Error(`Cowork plugin entry content differs: ${name}`)
  }

  if (!onDisk.equals(expectedArchive)) throw new Error('Cowork plugin bytes differ from the frozen Adapter plan')
  return { entries: actualNames, bytes: onDisk.length }
}

function readStoredZipEntries(archive) {
  const eocdOffset = findEndOfCentralDirectory(archive)
  requireRange(archive, eocdOffset, 22, 'end of central directory')
  const diskNumber = archive.readUInt16LE(eocdOffset + 4)
  const centralDisk = archive.readUInt16LE(eocdOffset + 6)
  const diskEntryCount = archive.readUInt16LE(eocdOffset + 8)
  const entryCount = archive.readUInt16LE(eocdOffset + 10)
  const centralSize = archive.readUInt32LE(eocdOffset + 12)
  const centralOffset = archive.readUInt32LE(eocdOffset + 16)
  const commentLength = archive.readUInt16LE(eocdOffset + 20)
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntryCount !== entryCount) {
    throw new Error('Cowork plugin central directory uses unsupported multi-disk layout')
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('Cowork plugin central directory uses unsupported ZIP64 layout')
  }
  if (commentLength !== 0 || eocdOffset + 22 !== archive.length) {
    throw new Error('Cowork plugin end record must not contain an archive comment or trailing bytes')
  }
  if (centralOffset + centralSize !== eocdOffset) {
    throw new Error('Cowork plugin central directory bounds are inconsistent')
  }

  const entries = []
  let cursor = centralOffset
  let expectedLocalOffset = 0
  for (let index = 0; index < entryCount; index += 1) {
    requireRange(archive, cursor, 46, 'central directory entry')
    if (archive.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error('Cowork plugin central directory signature is invalid')
    }
    const flags = archive.readUInt16LE(cursor + 8)
    const method = archive.readUInt16LE(cursor + 10)
    const expectedCrc = archive.readUInt32LE(cursor + 16)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const uncompressedSize = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const entryCommentLength = archive.readUInt16LE(cursor + 32)
    const entryDisk = archive.readUInt16LE(cursor + 34)
    const externalAttributes = archive.readUInt32LE(cursor + 38)
    const localOffset = archive.readUInt32LE(cursor + 42)
    const centralEntryLength = 46 + nameLength + extraLength + entryCommentLength
    requireRange(archive, cursor, centralEntryLength, 'central directory entry')
    if (flags !== EXPECTED_FLAGS || method !== 0) {
      throw new Error('Cowork plugin entry flags or compression differ from the deterministic generator')
    }
    if (extraLength !== 0 || entryCommentLength !== 0) {
      throw new Error('Cowork plugin central entry must not contain extra fields or comments')
    }
    if (entryDisk !== 0 || externalAttributes !== EXPECTED_EXTERNAL_ATTRIBUTES) {
      throw new Error('Cowork plugin central entry disk or regular-file attributes are invalid')
    }
    if (localOffset !== expectedLocalOffset) {
      throw new Error('Cowork plugin contains an archive prefix, entry gap, or reordered local entry')
    }
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    const local = readStoredLocalEntry({
      archive, localOffset, centralOffset, name, flags, method,
      expectedCrc, compressedSize, uncompressedSize,
    })
    entries.push({ name, body: local.body })
    expectedLocalOffset = local.endOffset
    cursor += centralEntryLength
  }
  if (cursor !== eocdOffset) throw new Error('Cowork plugin central directory entry set is inconsistent')
  if (expectedLocalOffset !== centralOffset) {
    throw new Error('Cowork plugin contains a gap before its central directory')
  }
  if (new Set(entries.map(entry => entry.name)).size !== entries.length) {
    throw new Error('Cowork plugin central directory contains duplicate entry names')
  }
  return entries
}

function readStoredLocalEntry({ archive, localOffset, centralOffset, name, flags, method, expectedCrc, compressedSize, uncompressedSize }) {
  requireRange(archive, localOffset, 30, `local entry ${name}`)
  if (archive.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
    throw new Error(`Cowork plugin local entry signature is invalid: ${name}`)
  }
  const localFlags = archive.readUInt16LE(localOffset + 6)
  const localMethod = archive.readUInt16LE(localOffset + 8)
  const localCrc = archive.readUInt32LE(localOffset + 14)
  const localCompressedSize = archive.readUInt32LE(localOffset + 18)
  const localUncompressedSize = archive.readUInt32LE(localOffset + 22)
  const localNameLength = archive.readUInt16LE(localOffset + 26)
  const localExtraLength = archive.readUInt16LE(localOffset + 28)
  if (localExtraLength !== 0) {
    throw new Error(`Cowork plugin local entry must not contain an extra field: ${name}`)
  }
  const bodyOffset = localOffset + 30 + localNameLength + localExtraLength
  requireRange(archive, localOffset, 30 + localNameLength + localExtraLength + compressedSize, `local entry ${name}`)
  const localName = archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8')
  if (localName !== name || localFlags !== flags || localMethod !== method
    || localCrc !== expectedCrc || localCompressedSize !== compressedSize
    || localUncompressedSize !== uncompressedSize || compressedSize !== uncompressedSize) {
    throw new Error(`Cowork plugin local and central entry metadata differ: ${name}`)
  }
  if (bodyOffset + compressedSize > centralOffset) {
    throw new Error(`Cowork plugin local entry overlaps its central directory: ${name}`)
  }
  const body = archive.subarray(bodyOffset, bodyOffset + compressedSize)
  if (crc32(body) !== expectedCrc) {
    throw new Error(`Cowork plugin archive integrity/CRC check failed: ${name}`)
  }
  return { body, endOffset: bodyOffset + compressedSize }
}

function findEndOfCentralDirectory(archive) {
  const minimumOffset = Math.max(0, archive.length - 22 - MAX_ZIP_COMMENT_BYTES)
  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  throw new Error('Cowork plugin central directory could not be read: end record missing')
}

function requireRange(buffer, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
    || offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error(`Cowork plugin ${label} is truncated or out of bounds`)
  }
}

function crc32(input) {
  let crc = 0xffffffff
  for (const byte of input) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
