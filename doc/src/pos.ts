import {Node, TextNode, DocNode} from "./node"
import {Walker} from "./context" // FIXME move

export class Pos {
  constructor(
    readonly parent: NodePos,
    readonly pos: number,
    readonly index: number,
    readonly inText: number
  ) {}

  advance(distance: number, walk?: Walker) {
    return distance ? advancePos(distance, this.parent, this.pos, this.index, this.inText, walk) : this
  }

  get nodeAfter() {
    if (this.index == this.parent.node.children.length) return null
    let node = this.parent.node.children[this.index]
    return this.inText && node.isText() ? node.cutText(this.inText) : node
  }

  get nodeBefore() {
    if (this.inText) return (this.parent.node.children[this.index] as TextNode).cutText(0, this.inText)
    return this.index ? this.parent.node.children[this.index - 1] : null
  }

  get depth() {
    let d = 0
    for (let n = this.parent; n.parent; n = n.parent) d++
    return d
  }

  static atStart(doc: DocNode) {
    return new Pos(cacheFor(doc).top, 0, 0, 0)
  }

  static resolve(doc: DocNode, pos: number): Pos {
    if (pos < 0 || pos > doc.length) throw new RangeError(`Resolving invalid position ${pos}`)
    let {top, cache} = cacheFor(doc), nearest: Pos | undefined, nearestDist = 0, result
    for (let elt of cache) {
      if (elt.pos == pos) return elt
      let dist = Math.abs(elt.pos - pos)
      if (!nearest || dist < nearestDist) {
        nearest = elt
        nearestDist = dist
      }
    }
    if (nearest) {
      let {parent} = nearest
      while (parent.start > pos || parent.end < pos) parent = parent.parent!
      result = advancePos(pos - parent.start, parent, parent.start, 0, 0)
    } else {
      result = advancePos(pos, top, 0, 0, 0)
    }
    return cache[cache.length < cacheSize ? cache.length : cachePos = (cachePos + 1) % cacheSize] = result
  }
}

const posCache = new Map<DocNode, {top: NodePos, cache: Pos[]}>(), cacheSize = 8
let cachePos = 0

function cacheFor(doc: DocNode) {
  let found = posCache.get(doc)
  if (!found) posCache.set(doc, found = {top: new NodePos(null, doc, 0, 0), cache: []})
  return found
}

export class NodePos {
  constructor(
    readonly parent: NodePos | null,
    readonly node: Node,
    readonly start: number,
    readonly index: number
  ) {}

  get before() {
    if (!this.parent) throw new Error("Accessing `before` on the top level node")
    return this.start - 1
  }

  get after() {
    if (!this.parent) throw new Error("Accessing `after` on the top level node")
    return this.start - 1 + this.node.length
  }

  get end() { return this.start + this.node.contentLength }

  get nextSibling() {
    return !this.parent || this.index == this.parent.node.children.length - 1 ? null
      : this.parent.node.children[this.index + 1]
  }

  get previousSibling() {
    return !this.parent || !this.index ? null : this.parent.node.children[this.index - 1]
  }
}

function advancePos(distance: number, parent: NodePos, pos: number, index: number, inText: number,
                    walk?: Walker) {
  let target = pos + distance, {node} = parent
  if (inText) {
    let text = node.children[index] as TextNode
    let textStart = pos - inText, textEnd = textStart + text.length
    if (walk) walk.skip(text.cutText(inText, Math.min(text.length, target - textStart)))
    if (target < textEnd)
      return new Pos(parent, target, index, target - textStart)
    pos = textEnd
    index++
  }
  while (pos < target) {
    if (index == node.children.length) {
      if (!parent.parent) throw new Error("Moving past end of document")
      if (walk) walk.leave()
      ;({index, parent} = parent)
      node = parent.node
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
        return new Pos(parent, target, index, target - pos)
      } else {
        if (walk) walk.enter(next.tag)
        pos++
        parent = new NodePos(parent, next, pos, index)
        node = next
        index = 0
      }
    }
  }
  return new Pos(parent, pos, index, 0)
}
