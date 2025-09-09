import {TokenType, Node, NodeJSON, TagJSON, Tag} from "./node"
import {Schema} from "./schema"
import {Walker} from "./pos"

export type CloseToken = {tokenType: TokenType.Close}

export const CloseToken = {
  tokenType: TokenType.Close as TokenType.Close,
  /// @internal
  toString() { return "CLOSE" }
} as CloseToken

export type Token = Node | Tag | CloseToken

export class Slice {
  readonly length: number

  constructor(readonly content: readonly Token[]) {
    this.length = content.reduce((l, e) => l + (e.tokenType == TokenType.Node ? e.length : 1), 0)
  }

  toJSON(): SliceJSON {
    return this.content.map(e => e.tokenType == TokenType.Node ? {node: e.toJSON()}
      : e.tokenType == TokenType.Open ? {open: e.toJSON()} : {close: true})
  }

  static fromJSON(schema: Schema, json: SliceJSON) {
    if (!Array.isArray(json)) throw new Error("Invalid slice JSON")
    return new Slice(json.map(value => {
      if (value.open) return schema.tagFromJSON(value.open)
      if (value.close) return CloseToken
      if (value.node) return schema.nodeFromJSON(value.node)
      throw new Error("Invalid slice JSON")
    }))
  }

  eq(other: Slice) {
    if (other.content.length != this.content.length) return false
    for (let i = 0; i < this.content.length; i++) {
      let a = this.content[i], b = other.content[i]
      if (a == CloseToken) {
        if (b != CloseToken) return false
      } else if (a.tokenType == TokenType.Node) {
        if (!((b.tokenType == TokenType.Node) && a.eq(b))) return false
      } else if (a.tokenType == TokenType.Open) {
        if (!((b.tokenType == TokenType.Open) && a.eq(b))) return false
      }
    }
    return true
  }

  run(track: Walker) {
    for (let elt of this.content) {
      if (elt.tokenType == TokenType.Open) track.enter(elt)
      else if (elt.tokenType == TokenType.Node) track.skip(elt)
      else track.leave()
    }
  }

  slice(from: number, to = this.length) {
    if (from == to) return Slice.empty
    let result: Token[] = [], off = 0
    for (let elt of this.content) {
      let start = off
      off += elt.tokenType == TokenType.Node ? elt.length : 1
      if (off <= from) continue
      if (start < from || off > to) {
        let inner = (elt as Node).slice(Math.max(0, from - start), Math.min((elt as Node).length, to - start))
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
    if (content.length && other.content.length && other.content[0].tokenType == TokenType.Node &&
        content[content.length - 1].tokenType == TokenType.Node) {
      other.content[0].pushTo(content as Node[])
      i = 1
    }
    for (; i < other.content.length; i++) content.push(other.content[i])
    return new Slice(content)
  }

  validate(schema: Schema) {
    for (let tok of this.content) {
      if (tok.tokenType == TokenType.Node) schema.validate(tok)
      else if (tok.tokenType == TokenType.Open) schema.validateTag(tok)
    }
  }

  static empty = new Slice([])

  toString() {
    return `<${this.content.join()}>`
  }
}

export type SliceJSON = readonly ({node: NodeJSON} | {open: TagJSON} | {close: true})[]
