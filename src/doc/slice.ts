import type {Plot, Part, Leaf} from "./node"
import {TextOutput} from "./text"
import {Schema} from "./schema"

export const enum TokenType { Open, Close, Part }

export const End = {
  tokenType: TokenType.Close,
  /// @internal
  toString() { return "[end]" }
} as {tokenType: TokenType.Close}

export interface SliceWalker {
  part(part: Part, pos: number): void
  open(label: Plot.Label.Any, pos: number): void
  close(pos: number): void
}

export type Token = Part | Plot.Label.Any | typeof Plot.End

export class Slice {
  readonly length: number

  constructor(readonly content: readonly Token[]) {
    this.length = content.reduce((l, e) => l + (e.tokenType == TokenType.Part ? e.length : 1), 0)
  }

  toJSON(): SliceJSON {
    return this.content.map(e => e.tokenType == TokenType.Part ? {node: e.toJSON()}
      : e.tokenType == TokenType.Open ? {open: e.toJSON()} : {close: true})
  }

  static fromJSON(schema: Schema, json: SliceJSON) {
    if (!Array.isArray(json)) throw new Error("Invalid slice JSON")
    return new Slice(json.map(value => {
      if (value.open) return schema.tagFromJSON(value.open)
      if (value.close) return End
      if (value.node) return schema.partFromJSON(value.node)
      throw new Error("Invalid slice JSON")
    }))
  }

  eq(other: Slice) {
    if (other.content.length != this.content.length) return false
    for (let i = 0; i < this.content.length; i++) {
      let a = this.content[i], b = other.content[i]
      if (a == End) {
        if (b != End) return false
      } else if (a.tokenType == TokenType.Part) {
        if (!((b.tokenType == TokenType.Part) && a.eq(b))) return false
      } else if (a.tokenType == TokenType.Open) {
        if (!((b.tokenType == TokenType.Open) && a.eq(b))) return false
      }
    }
    return true
  }

  run(track: SliceWalker, startPos = 0) {
    let pos = startPos
    for (let elt of this.content) {
      if (elt.tokenType == TokenType.Open) track.open(elt, pos++)
      else if (elt.tokenType == TokenType.Part) { track.part(elt, pos); pos += elt.length }
      else track.close(pos++)
    }
  }

  slice(from: number, to = this.length) {
    if (from == to) return Slice.empty
    let result: Token[] = [], off = 0
    for (let elt of this.content) {
      let start = off
      off += elt.tokenType == TokenType.Part ? elt.length : 1
      if (off <= from) continue
      if (start < from || off > to) {
        let inner = (elt as Part).slice(Math.max(0, from - start), Math.min((elt as Plot).length, to - start))
        for (let elt of inner.content) result.push(elt)
      } else {
        result.push(elt)
      }
      if (off >= to) break
    }
    return new Slice(result)
  }

  concat(other: Slice) {
    let content = this.content.slice()
    let i = 0
    if (content.length && other.content.length && other.content[0].tokenType == TokenType.Part &&
        content[content.length - 1].tokenType == TokenType.Part) {
      other.content[0].pushTo(content as Part[])
      i = 1
    }
    for (; i < other.content.length; i++) content.push(other.content[i])
    return new Slice(content)
  }

  validate(schema: Schema) {
    for (let tok of this.content) {
      if (tok.tokenType == TokenType.Part) schema.validate(tok)
      else if (tok.tokenType == TokenType.Open) schema.validateTag(tok)
    }
  }

  textContent(options: {
    blockSeparator?: string,
    leafText?: string | ((node: Leaf.Any) => string)
  } = {}) {
    let {blockSeparator = "\n", leafText} = options
    let out = new TextOutput(blockSeparator, leafText == null ? undefined : typeof leafText == "string" ? () => leafText : leafText)
    for (let tok of this.content) {
      if (tok.tokenType == TokenType.Open) {
        if (tok.isTextblock) out.openBlock()
      } else if (tok.tokenType == TokenType.Part) {
        if (tok.isLeaf) out.serialize(tok)
        else tok.iterate(node => !out.serialize(node))
      }
    }
    return out.text
  }

  static empty = new Slice([])

  toString() {
    return `<${this.content.join()}>`
  }
}

export type SliceJSON = readonly ({node: Part.JSON} | {open: Part.JSON} | {close: true})[]
