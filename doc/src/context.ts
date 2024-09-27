import {Node, Tag, TextNode, DocNode} from "./node"
import {none} from "./helper"

export interface Walker {
  skip(node: Node): void
  enter(tag: Tag): void
  leave(): void
}

// FIXME reconsider an array representation
export class Context {
  constructor(
    readonly node: Node,
    readonly index: number,
    readonly pos: number,
    readonly inText: number,
    readonly parent: Context | null
  ) {}

  advance(distance: number, walk?: Walker) {
    return distance ? advanceContext(distance, this.node, this.index, this.pos, this.inText, this.parent, walk) : this
  }

  get start() {
    return this.parent ? this.parent.pos + 1 : 0
  }

  get end() {
    return this.start + this.node.contentLength
  }

  get before() {
    if (!this.parent) throw new Error("Reading Context.before on a top-level context")
    return this.parent.pos
  }

  get after() {
    if (!this.parent) throw new Error("Reading Context.after on a top-level context")
    return this.parent.pos + this.node.length
  }

  get nodeAfter() {
    if (this.index == this.node.children.length) return null
    let node = this.node.children[this.index]
    return this.inText && node.isText() ? node.cutText(this.inText) : node
  }

  get nodeBefore() {
    if (this.inText) return (this.node.children[this.index] as TextNode).cutText(0, this.inText)
    return this.index ? this.node.children[this.index - 1] : null
  }

  get depth() {
    let d = 0
    for (let c = this.parent; c; c = c.parent) d++
    return d
  }

  atDepth(depth: number) {
    let c = this as Context
    for (let off = this.depth - depth; off > 0; off--) c = c.parent!
    return c
  }

  props(across?: Context) {
    if (this.inText && !across) return this.node.children[this.index].tag.props
    let [from, to] = !across ? [this, this] : across.pos > this.pos ? [this, across] : [across, this]
    let before = from.nodeBefore, after = to.nodeAfter
    let [main, sec] = before ? [before.tag.props, after ? after.tag.props : none]
      : [after ? after.tag.props : none, none]
    return main.filter(p => p.type.inclusive || p.isInSet(sec))
  }

  static atStart(doc: DocNode) {
    return new Context(doc, 0, 0, 0, null)
  }

  static resolve(doc: DocNode, pos: number): Context {
    let cache = contextCache.get(doc), nearest: Context | undefined
    if (!cache) {
      contextCache.set(doc, cache = [])
    } else {
      for (let elt of cache) {
        if (elt.pos == pos) return elt
        else if (elt.pos < pos && (!nearest || nearest.pos < elt.pos)) nearest = elt
      }
    }
    let result = nearest ? nearest.advance(pos - nearest.pos) : advanceContext(pos, doc, 0, 0, 0, null)
    return cache[cache.length < cacheSize ? cache.length : cachePos = (cachePos + 1) % cacheSize] = result
  }
}

let contextCache = new Map<DocNode, Context[]>(), cacheSize = 8, cachePos = 0

function advanceContext(distance: number, node: Node, index: number,
                        pos: number, inText: number, parent: Context | null,
                        walk?: Walker) {
  let target = pos + distance
  if (inText) {
    let text = node.children[index] as TextNode
    let textStart = pos - inText, textEnd = textStart + text.length
    if (walk) walk.skip(text.cutText(inText, Math.min(node.length, target - textStart)))
    if (target < textEnd)
      return new Context(node, index, target, target - textStart, parent)
    pos = textEnd
    index++
  }
  while (pos < target) {
    if (index == node.children.length) {
      if (!parent) throw new Error("Moving past end of document")
      if (walk) walk.leave()
      ;({node, index, parent} = parent)
      index++
      pos++
    } else {
      let next = node.children[index], end = pos + next.length
      if (target >= end) {
        if (walk) walk.skip(next)
        pos = end
        index++
      } else if (next.isText()) {
        if (walk) walk.skip(next.cutText(0, target - pos))
        return new Context(node, index, target, target - pos, parent)
      } else {
        if (walk) walk.enter(next.tag)
        parent = new Context(node, index, pos, 0, parent)
        pos++
        node = next
        index = 0
      }
    }
  }
  return new Context(node, index, pos, 0, parent)
}
