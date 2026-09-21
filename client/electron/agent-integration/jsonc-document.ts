import type { JsonValue } from './types'

interface JsoncNode {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'
  offset: number
  end: number
  value: JsonValue
  properties?: JsoncProperty[]
}

interface JsoncProperty {
  key: string
  offset: number
  end: number
  valueNode: JsoncNode
  commaOffset: number | null
}

export interface JsoncObjectDocument {
  root: Record<string, JsonValue>
  rootNode: JsoncNode
}

/** Parse the JSON-with-comments and trailing-comma dialect documented by OpenCode. */
export function parseJsoncObject(source: string): JsoncObjectDocument {
  const parser = new JsoncParser(source)
  const rootNode = parser.parse()
  if (rootNode.type !== 'object') throw new Error('container_root_not_object')
  return { root: rootNode.value as Record<string, JsonValue>, rootNode }
}

/**
 * Change only the selected property in a JSONC document. Unrelated whitespace,
 * comments, key ordering and formatting remain byte-for-byte unchanged.
 */
export function modifyJsoncObject(
  source: string,
  selector: readonly string[],
  desired: JsonValue | undefined,
): string {
  const document = parseJsoncObject(source)
  const located = locateProperty(document.rootNode, selector)

  if (desired === undefined) {
    if (located.property === undefined) return source
    return removeProperty(source, located.parent, located.property)
  }

  if (located.property !== undefined) {
    const indentation = formattingAt(source, located.property.valueNode.offset)
    const replacement = formatValue(desired, indentation.baseIndent, indentation.indentUnit, indentation.newline)
    return splice(source, located.property.valueNode.offset, located.property.valueNode.end, replacement)
  }

  if (located.missingIndex === undefined) throw new Error('jsonc_selector_location_failed')
  if (located.parent.type !== 'object') throw new Error(`selector_parent_not_object:${selector[located.missingIndex - 1] ?? '<root>'}`)

  const nested = buildNestedValue(selector.slice(located.missingIndex + 1), desired)
  return insertProperty(source, located.parent, selector[located.missingIndex], nested)
}

function locateProperty(root: JsoncNode, selector: readonly string[]): {
  parent: JsoncNode
  property?: JsoncProperty
  missingIndex?: number
} {
  let current = root
  for (let index = 0; index < selector.length; index += 1) {
    if (current.type !== 'object') throw new Error(`selector_parent_not_object:${selector[index - 1] ?? '<root>'}`)
    const property = current.properties?.find(candidate => candidate.key === selector[index])
    if (property === undefined) return { parent: current, missingIndex: index }
    if (index === selector.length - 1) return { parent: current, property }
    current = property.valueNode
  }
  throw new Error('invalid_json_selector')
}

function buildNestedValue(remaining: readonly string[], desired: JsonValue): JsonValue {
  let value = desired
  for (const key of [...remaining].reverse()) value = { [key]: value }
  return value
}

function insertProperty(source: string, object: JsoncNode, key: string, value: JsonValue): string {
  const properties = object.properties ?? []
  const formatting = formattingAt(source, object.offset)
  const multiline = source.slice(object.offset, object.end).includes('\n')
  const childIndent = inferChildIndent(source, object, formatting.baseIndent, formatting.indentUnit)
  const renderedValue = formatValue(
    value,
    multiline ? childIndent : '',
    formatting.indentUnit,
    formatting.newline,
    !multiline,
  )
  const renderedProperty = `${JSON.stringify(key)}: ${renderedValue}`
  const prefix = multiline ? `${formatting.newline}${childIndent}` : (properties.length > 0 ? '' : ' ')
  const suffix = properties.length > 0 ? (multiline ? ',' : ', ') : ''
  return splice(source, object.offset + 1, object.offset + 1, `${prefix}${renderedProperty}${suffix}`)
}

function removeProperty(source: string, object: JsoncNode, property: JsoncProperty): string {
  const properties = object.properties ?? []
  const index = properties.indexOf(property)
  const edits: Array<{ start: number; end: number; replacement: string }> = []
  if (property.commaOffset !== null) {
    const leading = index === 0 && /^[\t \r\n]*$/.test(source.slice(object.offset + 1, property.offset))
      ? object.offset + 1
      : property.offset
    edits.push({ start: leading, end: property.commaOffset + 1, replacement: '' })
  } else {
    const previous = index > 0 ? properties[index - 1] : undefined
    if (previous?.commaOffset !== null && previous?.commaOffset !== undefined) {
      edits.push({ start: previous.commaOffset, end: previous.commaOffset + 1, replacement: '' })
    }
    edits.push({ start: property.offset, end: property.end, replacement: '' })
  }
  return applyEdits(source, edits)
}

function inferChildIndent(source: string, object: JsoncNode, baseIndent: string, indentUnit: string): string {
  const first = object.properties?.[0]
  if (first !== undefined) {
    const lineStart = Math.max(source.lastIndexOf('\n', first.offset - 1), source.lastIndexOf('\r', first.offset - 1)) + 1
    const indentation = source.slice(lineStart, first.offset)
    if (/^[\t ]*$/.test(indentation)) return indentation
  }
  return `${baseIndent}${indentUnit}`
}

function formattingAt(source: string, offset: number): {
  newline: '\n' | '\r\n'
  baseIndent: string
  indentUnit: string
} {
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const lineBreak = source.lastIndexOf('\n', offset - 1)
  const lineStart = lineBreak < 0 ? 0 : lineBreak + 1
  const prefix = source.slice(lineStart, offset)
  const baseIndent = prefix.match(/^[\t ]*/)?.[0] ?? ''
  const indentMatch = source.match(/\r?\n([\t ]+)\S/)
  const indentUnit = indentMatch?.[1].includes('\t') ? '\t' : '  '
  return { newline, baseIndent, indentUnit }
}

function formatValue(
  value: JsonValue,
  baseIndent: string,
  indentUnit: string,
  newline: '\n' | '\r\n',
  compact = false,
): string {
  if (compact) return JSON.stringify(value)
  return JSON.stringify(value, null, indentUnit).replace(/\n/g, `${newline}${baseIndent}`)
}

function splice(source: string, start: number, end: number, replacement: string): string {
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`
}

function applyEdits(
  source: string,
  edits: readonly { start: number; end: number; replacement: string }[],
): string {
  return [...edits]
    .sort((left, right) => right.start - left.start)
    .reduce((result, edit) => splice(result, edit.start, edit.end, edit.replacement), source)
}

class JsoncParser {
  private position = 0

  constructor(private readonly source: string) {}

  parse(): JsoncNode {
    this.skipTrivia()
    const root = this.parseValue()
    this.skipTrivia()
    if (this.position !== this.source.length) this.fail('unexpected_trailing_content')
    return root
  }

  private parseValue(): JsoncNode {
    this.skipTrivia()
    const character = this.source[this.position]
    if (character === '{') return this.parseObject()
    if (character === '[') return this.parseArray()
    if (character === '"') return this.parseString()
    if (character === '-' || isDigit(character)) return this.parseNumber()
    if (this.source.startsWith('true', this.position)) return this.parseLiteral('true', true, 'boolean')
    if (this.source.startsWith('false', this.position)) return this.parseLiteral('false', false, 'boolean')
    if (this.source.startsWith('null', this.position)) return this.parseLiteral('null', null, 'null')
    this.fail('expected_value')
  }

  private parseObject(): JsoncNode {
    const offset = this.position
    this.position += 1
    const value: Record<string, JsonValue> = {}
    const properties: JsoncProperty[] = []
    const keys = new Set<string>()
    this.skipTrivia()
    if (this.consume('}')) return { type: 'object', offset, end: this.position, value, properties }

    while (true) {
      this.skipTrivia()
      const keyNode = this.parseString()
      const key = keyNode.value as string
      if (keys.has(key)) this.fail(`duplicate_object_key:${key}`, keyNode.offset)
      keys.add(key)
      this.skipTrivia()
      if (!this.consume(':')) this.fail('expected_colon')
      const valueNode = this.parseValue()
      const property: JsoncProperty = {
        key,
        offset: keyNode.offset,
        end: valueNode.end,
        valueNode,
        commaOffset: null,
      }
      properties.push(property)
      value[key] = valueNode.value
      this.skipTrivia()
      if (this.consume(',')) {
        property.commaOffset = this.position - 1
        this.skipTrivia()
        if (this.consume('}')) return { type: 'object', offset, end: this.position, value, properties }
        continue
      }
      if (this.consume('}')) return { type: 'object', offset, end: this.position, value, properties }
      this.fail('expected_comma_or_object_end')
    }
  }

  private parseArray(): JsoncNode {
    const offset = this.position
    this.position += 1
    const value: JsonValue[] = []
    this.skipTrivia()
    if (this.consume(']')) return { type: 'array', offset, end: this.position, value }
    while (true) {
      value.push(this.parseValue().value)
      this.skipTrivia()
      if (this.consume(',')) {
        this.skipTrivia()
        if (this.consume(']')) return { type: 'array', offset, end: this.position, value }
        continue
      }
      if (this.consume(']')) return { type: 'array', offset, end: this.position, value }
      this.fail('expected_comma_or_array_end')
    }
  }

  private parseString(): JsoncNode {
    const offset = this.position
    if (!this.consume('"')) this.fail('expected_string')
    let escaped = false
    while (this.position < this.source.length) {
      const character = this.source[this.position]
      if (!escaped && character === '"') {
        this.position += 1
        const token = this.source.slice(offset, this.position)
        let value: string
        try { value = JSON.parse(token) as string } catch { this.fail('invalid_string', offset) }
        return { type: 'string', offset, end: this.position, value: value! }
      }
      if (!escaped && (character === '\n' || character === '\r')) this.fail('unterminated_string', offset)
      escaped = !escaped && character === '\\'
      if (character !== '\\') escaped = false
      this.position += 1
    }
    this.fail('unterminated_string', offset)
  }

  private parseNumber(): JsoncNode {
    const offset = this.position
    const match = this.source.slice(this.position).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    if (match === null) this.fail('invalid_number')
    this.position += match![0].length
    const value = Number(match![0])
    if (!Number.isFinite(value)) this.fail('invalid_number', offset)
    return { type: 'number', offset, end: this.position, value }
  }

  private parseLiteral(
    token: 'true' | 'false' | 'null',
    value: boolean | null,
    type: 'boolean' | 'null',
  ): JsoncNode {
    const offset = this.position
    this.position += token.length
    return { type, offset, end: this.position, value }
  }

  private skipTrivia(): void {
    while (this.position < this.source.length) {
      const character = this.source[this.position]
      if (/\s/.test(character)) {
        this.position += 1
        continue
      }
      if (character === '/' && this.source[this.position + 1] === '/') {
        this.position += 2
        while (this.position < this.source.length && !['\n', '\r'].includes(this.source[this.position])) this.position += 1
        continue
      }
      if (character === '/' && this.source[this.position + 1] === '*') {
        const end = this.source.indexOf('*/', this.position + 2)
        if (end < 0) this.fail('unterminated_block_comment')
        this.position = end + 2
        continue
      }
      break
    }
  }

  private consume(character: string): boolean {
    if (this.source[this.position] !== character) return false
    this.position += 1
    return true
  }

  private fail(reason: string, offset = this.position): never {
    throw new Error(`${reason} at offset ${offset}`)
  }
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= '0' && value <= '9'
}
