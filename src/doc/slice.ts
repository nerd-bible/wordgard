import type {Plot, Node, Leaf} from "./node"
import {TextOutput} from "./text"
import {Schema} from "./schema"
import {ValidationError} from "./error"

/// The type of tokens in a slice. A plot tag represents the point
/// where a plot is opened, {@link Plot.End} the point where a plot is
/// closed, and nodes just represent the insertion of that node.
export type Token = Node | Plot.Tag.Any | typeof Plot.End

export namespace Token {
  /// Tokens have a `tokenType` property holding oneof these values.
  export enum Type { Open, Close, Node }

  /// @internal
  export const End = {
    tokenType: Token.Type.Close,
    /// @internal
    toString() { return "[end]" }
  } as {tokenType: Token.Type.Close}
}

/// A slice represents a part of a document. It is used to represent
/// inserted content in {@link ChangeSet change sets}, or things like
/// clipboard content.
export class Slice {
  /// The length of the slice's content.
  readonly length: number

  private constructor(readonly content: readonly Token[]) {
    this.length = content.reduce((l, e) => l + (e.tokenType == Token.Type.Node ? e.length : 1), 0)
  }

  /// Create a slice.
  static of(content: readonly Token[]) { return new Slice(content) }

  /// Compare a slice to another one.
  eq(other: Slice) {
    if (other.content.length != this.content.length) return false
    for (let i = 0; i < this.content.length; i++) {
      let a = this.content[i], b = other.content[i]
      if (a == Token.End) {
        if (b != Token.End) return false
      } else if (a.tokenType == Token.Type.Node) {
        if (!((b.tokenType == Token.Type.Node) && a.eq(b))) return false
      } else if (a.tokenType == Token.Type.Open) {
        if (!((b.tokenType == Token.Type.Open) && a.eq(b))) return false
      }
    }
    return true
  }

  /// @internal
  run(track: SliceWalker, startPos = 0) {
    let pos = startPos
    for (let elt of this.content) {
      if (elt.tokenType == Token.Type.Open) track.open(elt, pos++)
      else if (elt.tokenType == Token.Type.Node) { track.node(elt, pos); pos += elt.length }
      else track.close(pos++)
    }
  }

  /// Create a sub-slice of this slice.
  slice(from: number, to = this.length) {
    if (from == to) return Slice.empty
    let result: Token[] = [], off = 0
    for (let elt of this.content) {
      let start = off
      off += elt.tokenType == Token.Type.Node ? elt.length : 1
      if (off <= from) continue
      if (start < from || off > to) {
        let inner = (elt as Node).sliceInner(Math.max(0, from - start), Math.min((elt as Plot).length, to - start))
        for (let elt of inner.content) result.push(elt)
      } else {
        result.push(elt)
      }
      if (off >= to) break
    }
    return new Slice(result)
  }

  /// Concatenate this slice to another slice.
  concat(other: Slice) {
    let content = this.content.slice()
    let i = 0
    if (content.length && other.content.length && other.content[0].tokenType == Token.Type.Node &&
        content[content.length - 1].tokenType == Token.Type.Node) {
      other.content[0].pushTo(content as Node[])
      i = 1
    }
    for (; i < other.content.length; i++) content.push(other.content[i])
    return new Slice(content)
  }

  /// Get the text content of the slice's tokens.
  textContent(options: {
    blockSeparator?: string,
    leafText?: string | ((node: Leaf.Any) => string)
  } = {}) {
    let {blockSeparator = "\n", leafText} = options
    let out = new TextOutput(blockSeparator, leafText == null ? undefined : typeof leafText == "string" ? () => leafText : leafText)
    for (let tok of this.content) {
      if (tok.tokenType == Token.Type.Open) {
        if (tok.isTextblock) out.openBlock()
      } else if (tok.tokenType == Token.Type.Node) {
        if (tok.isLeaf) out.serialize(tok)
        else tok.iterate(node => !out.serialize(node))
      }
    }
    return out.text
  }

  /// The empty slice.
  static empty = new Slice([])

  /// @internal
  toString() {
    return `<${this.content.join()}>`
  }

  /// Convert this slice to a JSON-serializeable representation.
  toJSON(): Slice.JSON {
    return this.content.map(e => e.tokenType == Token.Type.Node ? {node: e.toJSON()}
      : e.tokenType == Token.Type.Open ? {open: e.toJSON()} : {close: true})
  }

  /// Build a slice from its JSON representation.
  static fromJSON(schema: Schema, json: Slice.JSON) {
    if (!Array.isArray(json)) throw new ValidationError("Invalid slice JSON")
    return new Slice(json.map(value => {
      if (value.open) return schema.tagFromJSON(value.open)
      if (value.close) return Token.End
      if (value.node) return schema.nodeFromJSON(value.node)
      throw new ValidationError("Invalid slice JSON")
    }))
  }
}

export namespace Slice {
  /// A slice's JSON representation.
  export type JSON = readonly ({node: Node.JSON} | {open: Node.JSON} | {close: true})[]
}

export interface SliceWalker {
  node(node: Node, pos: number): void
  open(tag: Plot.Tag.Any, pos: number): void
  close(pos: number): void
}
