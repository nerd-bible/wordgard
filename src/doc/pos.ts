import type {Part, Plot, Leaf} from "./node"
import {Prop} from "./prop"
import {none} from "./helper"

export interface Walker {
  skip(part: Part, pos: number, parent: PlotPos, index: number): void
  enterPlot(node: Plot, pos: number, parent: PlotPos, index: number): void | boolean
  leavePlot(label: Plot.Label.Any | undefined, pos: number, parent: PlotPos | null, index: number): void
}

export class Pos {
  constructor(
    readonly parent: PlotPos,
    readonly pos: number,
    readonly index: number,
    readonly inText: number
  ) {}

  advance(distance: number, walk?: Walker) {
    return distance ? advancePos(distance, this.parent, this.pos, this.index, this.inText, walk) : this
  }

  walk(distance: number, walk: Walker) {
    return distance ? advancePos(distance, this.parent, this.pos, this.index, this.inText, walk, true) : this
  }

  get nodeAfter() {
    if (this.index == this.parent.part.content.length) return null
    let node = this.parent.part.content[this.index]
    return this.inText ? (node as Leaf<string>).sliceText(this.inText) : node
  }

  get nodeBefore() {
    if (this.inText) return (this.parent.part.content[this.index] as Leaf<string>).sliceText(0, this.inText)
    return this.index ? this.parent.part.content[this.index - 1] : null
  }

  get textblockParent() {
    for (let p: PlotPos | null = this.parent;; p = p.parent) {
      if (!p || !p.part.inlineContent) return null
      if (p.part.isTextblock) return p
    }
  }

  isAtStart(parent: PlotPos) {
    if (this.inText) return false
    for (let p: PlotPos | null = this.parent, index = this.index;; index = p.index, p = p.parent) {
      if (!p || index) return false
      if (p == parent) return true
    }
  }

  isAtEnd(parent: PlotPos) {
    if (this.inText) return false
    for (let p: PlotPos | null = this.parent, index = this.index;; index = p.index + 1, p = p.parent) {
      if (!p || index < p.part.content.length) return false
      if (p == parent) return true
    }
  }

  get depth() { return this.parent.depth }

  get doc() { return this.parent.doc }

  props(across?: Pos) {
    if (this.inText && !across) return this.parent.part.content[this.index].label.props
    let [from, to] = !across ? [this, this] : across.pos > this.pos ? [this, across] : [across, this]
    let before = from.nodeBefore, after = to.nodeAfter
    let [main, sec]: [readonly Prop[], readonly Prop[]] =
      before ? [before.label.props, after ? after.label.props : none] : [after ? after.label.props : none, none]
    return main.filter(p => p.type.spanning && (p.type.inclusive || p.isInSet(sec)))
  }

  static atStart(doc: Plot.Doc) {
    return new Pos(cacheFor(doc).top, 0, 0, 0)
  }

  static resolve(doc: Plot.Doc, pos: number): Pos {
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

  static resolveNode(doc: Plot.Doc, pos: number) {
    let base = this.resolve(doc, pos)
    if (base.inText) return null
    let after = base.nodeAfter
    return after && !after.isText ? new (after.isLeaf ? PartPos : PlotPos)(base.parent, after, pos, base.index) : null
  }
}

const posCache = new Map<Plot.Doc, {top: PlotPos, cache: Pos[]}>(), cacheSize = 8
let cachePos = 0

function cacheFor(doc: Plot.Doc) {
  let found = posCache.get(doc)
  if (!found) posCache.set(doc, found = {top: new PlotPos(null, doc, -1, 0), cache: []})
  return found
}

export class PartPos {
  constructor(
    readonly parent: PlotPos | null,
    readonly part: Part,
    /// @internal
    readonly pos: number,
    readonly index: number
  ) {}

  get before() {
    if (this.pos < 0) throw new Error("Accessing `before` on the top level node")
    return this.pos
  }

  get after() {
    if (this.pos < 0) throw new Error("Accessing `after` on the top level node")
    return this.pos + this.part.length
  }

  get depth() {
    let d = 0
    for (let n: PartPos = this; n.parent; n = n.parent) d++
    return d
  }

  get doc(): Plot.Doc {
    let n: PartPos = this
    while (n.parent) n = n.parent
    if (!((n as PlotPos).part.isDoc)) throw new Error("Outer parent not a document")
    return n.part as Plot.Doc
  }

  get isFirst() { return !this.parent || this.index == 0 }
  get isLast() { return !this.parent || this.index == this.parent.part.content.length - 1 }

  get nextSibling() { return this.isLast ? null : this.parent!.part.content[this.index + 1] }
  get previousSibling() { return this.isFirst ? null : this.parent!.part.content[this.index - 1] }
}

export class PlotPos extends PartPos {
  declare part: Plot
  
  constructor(
    parent: PlotPos | null,
    part: Plot,
    pos: number,
    index: number
  ) {
    super(parent, part, pos, index)
  }
  
  get start() { return this.pos + 1 }

  get end() { return this.pos + 1 + this.part.contentLength }
}

function advancePos(distance: number, parent: PlotPos, pos: number, index: number, inText: number,
                    walk?: Walker, full = false) {
  let target = pos + distance, {part} = parent
  if (inText) {
    let text = part.content[index] as Leaf<string>
    let textStart = pos - inText, textEnd = textStart + text.length
    if (walk) walk.skip(text.sliceText(inText, Math.min(text.length, target - textStart)), pos, parent, index)
    if (target < textEnd)
      return new Pos(parent, target, index, target - textStart)
    pos = textEnd
    index++
  }
  while (pos < target) {
    if (index == part.content.length) {
      if (!parent.parent) throw new Error("Moving past end of document")
      if (walk) walk.leavePlot(part.label, pos, parent.parent, parent.index)
      ;({index, parent} = parent)
      part = parent.part
      index++
      pos++
    } else {
      let next = part.content[index], end = pos + next.length
      if (next.isLeaf) {
        if (next.isText && target < end) {
          if (walk) walk.skip(next.sliceText(0, target - pos), pos, parent, index)
          return new Pos(parent, target, index, target - pos)
        } else {
          if (walk) walk.skip(next, pos, parent, index)
          pos = end
          index++
        }
      } else {
        let enter = full || target < end
        if (walk) {
          if (!enter) walk.skip(next, pos, parent, index)
          else if (walk.enterPlot(next, pos, parent, index) === false && target >= end) enter = false
        }
        if (enter) {
          parent = new PlotPos(parent, next, pos, index)
          pos++
          part = next
          index = 0
        } else {
          pos = end
          index++
        }
      }
    }
  }
  return new Pos(parent, pos, index, 0)
}
