import {Node as WGNode, Tag, ChangeDesc} from "@wordgard/doc"
import {EditorState} from "@wordgard/state"
import {Shape} from "./shape"
import {DecoIterator, findChangedRanges} from "./decoration"
import {Elt, Widget} from "./shape"
import {compareAttributes, Attributes} from "./shape"

declare global {
  interface Node { wsElt?: Tile }
}

export const enum TileFlag { // FIXME use for widget side
  NodeInner = 1,
  Synced = 2,
  Point = 4,
  PointBefore = 8,
  PointAfter = 16
}

export class ContentPos {
  constructor(
    readonly tile: Tile,
    readonly offset: number,
    readonly pos: number
  ) {}

  get dom() { return this.tile.dom }
}

// Nodes in the view tree are called tiles. We're already using "node"
// for too many things. I know tiles don't generally nest recursively,
// but these do.

export abstract class Tile {
  parent: CompositeTile | null = null
  abstract children: Tile[]
  length = 0
  flags: TileFlag

  constructor(readonly dom: Node, flags: number) {
    this.flags = flags & ~TileFlag.Synced
    dom.wsElt = this
  }

  get isAtom() { return false }
  get isNodeOuter() { return false }
  get isNodeInner() { return (this.flags & TileFlag.NodeInner) > 0 }
  get isNode() { return this.isNodeOuter || (this.flags & TileFlag.NodeInner) > 0 }
  get isText() { return false }
  get isDoc() { return false }
  get isSpanning() { return false }
  get isPoint() { return (this.flags & TileFlag.Point) > 0 }

  get depth() {
    let depth = 0
    for (let n: Tile | null = this; n; n = n.parent) if (n.isNodeOuter) depth++
    return depth
  }

  posBeforeChild(child: Tile): number {
    for (let i = 0, pos = this.posAtStart;; i++) {
      let cur = this.children[i]
      if (cur == child) return pos
      pos += cur.length
    }
  }

  get posBefore() {
    return this.parent!.posBeforeChild(this)
  }

  get posAtStart() {
    return this.parent ? this.parent.posBeforeChild(this) + this.boundary : 0
  }

  get posAfter() {
    return this.posBefore + this.length
  }

  get posAtEnd() {
    return this.posAtStart + this.length - 2 * this.boundary
  }

  get boundary(): 0 | 1 { return 0 }

  get firstChild(): Tile | null {
    return this.children.length ? this.children[0] : null
  }

  get lastChild(): Tile | null {
    let last = this.children.length - 1
    return last < 0 ? null : this.children[last]
  }

  // FIXME review for new approach
  localPosFromDOM(dom: Node, offset: number, bias: -1 | 1): number {
    // If the DOM position is in the content, use the child desc after
    // it to figure out a position.
    if (this.dom.contains(dom)) {
      let domBefore, elt: Tile | undefined
      if (dom == this.dom) {
        domBefore = dom.childNodes[offset - 1]
      } else {
        while (dom.parentNode != this.dom) dom = dom.parentNode!
        domBefore = dom.previousSibling
      }
      while (domBefore && !((elt = domBefore.wsElt) && elt.parent == this as Tile))
        domBefore = domBefore.previousSibling
      return domBefore ? this.posBeforeChild(elt!) + elt!.length : this.posAtStart
    }
    // Otherwise, use various heuristics, falling back on the bias
    // parameter, to determine whether to return the position at the
    // start or at the end of this content element.
    if (this.dom && this.dom != this.dom) {
      let cmp = dom.compareDocumentPosition(this.dom)
      if (cmp & 2) return this.posAtEnd
      else if (cmp & 4) return this.posAtStart
    } else if (this.dom.firstChild) {
      if (offset == 0) for (let search = dom;; search = search.parentNode!) {
        if (search == this.dom) return this.posAtStart
        if (search.previousSibling) break
      }
      if (offset == dom.childNodes.length) for (let search = dom;; search = search.parentNode!) {
        if (search == this.dom) return this.posAtEnd
        if (search.nextSibling) break
      }
    }
    return bias > 0 ? this.posAtEnd : this.posAtStart
  }

  ignoreEvent(event: Event) { return false } // FIXME implement or redesign

  get ignoreMutations() { return false }

  toString() { return this.dom.nodeName + (this.children.length ? `(${this.children})` : "") }

  sync() {}
}

export class CompositeTile extends Tile {
  children: Tile[] = []

  addChild(child: Tile) {
    if (this.flags & TileFlag.Synced) throw new Error("Cannot add to a synced tile")
    this.children.push(child)
    child.parent = this
  }

  sync() {
    if (this.flags & TileFlag.Synced) return
    this.flags |= TileFlag.Synced
    let len = 0
    for (let ch of this.children) {
      ch.sync()
      len += ch.length
    }
    this.length += len
    this.syncChildren()
  }

  syncChildren() {
    let prev: Node | null = null, next: Node | null = this.dom.firstChild
    for (let child of this.children) {
      if (child.dom.parentNode == this.dom) {
        while (next && next != child.dom) next = rm(next)
      } else {
        this.dom.insertBefore(child.dom, next)
      }
      prev = child.dom
      next = prev.nextSibling
    }
    while (next) next = rm(next)
  }
}

const enum Bound { Start = 1, End = 2 }

export class DocTile extends CompositeTile {
  declare dom: HTMLElement

  constructor(public state: EditorState, dom: HTMLElement) {
    super(dom, 0)
  }

  static create(state: EditorState, dom: HTMLElement) {
    return new DocTile(state, dom).updateRanges(state, [0, state.doc.length])
  }

  get isDoc() { return true }

  update(state: EditorState, changes: ChangeDesc) {
    return this.updateRanges(state, findChangedRanges(this.state, state, changes))
  }

  updateRanges(state: EditorState, sections: readonly number[]) {
    if (sections.length == 2 && sections[1] == -1) return this
    let builder = new ContentUpdate(state, this, new DecoIterator(state))
    for (let i = 0; i < sections.length;) {
      let bound = (i == 0 ? Bound.Start : 0) | (i == sections.length - 2 ? Bound.End : 0)
      let len = sections[i++], ins = sections[i++]
      if (ins == -1) {
        builder.keep(len, bound)
      } else if (ins == -2) {
        builder.update(len, bound)
      } else {
        builder.replace(len, ins, bound)
      }
    }
    return builder.finish()
  }

  nearest(dom: Node, requireTag = true) {
    for (let cur: Node | null = dom; cur; cur = cur.parentNode) {
      let elt = cur.wsElt
      if (elt && (!requireTag || elt.isNode) && this.owns(elt)) return elt
    }
    return null
  }

  owns(elt: Tile) {
    for (;;) {
      let {parent} = elt
      if (parent == this) return true
      if (!parent) return false
      elt = parent
    }
  }

  // FIXME document or change weird assoc descent behavior
  resolve(pos: number, assoc: -1 | 0 | 1) {
    let parent: Tile = this, index = 0, off = 0
    for (;;) {
      if (off == pos) {
        let before = index ? parent.children[index - 1] : null
        let after = index < parent.children.length ? parent.children[index] : null
        if (before?.boundary) before = null
        if (after?.boundary) after = null
        if (assoc == 0 || !before && !after) return new ContentPos(parent, index, pos)
        if (!after || before && assoc < 0) {
          if (before instanceof TextTile) return new ContentPos(before, before.length, pos)
          parent = before!; index = before!.children.length
        } else {
          if (after instanceof TextTile) return new ContentPos(after, 0, pos)
          parent = after; index = 0
        }
      } else {
        let next = parent.children[index]
        if (off + next.length > pos) {
          if (next instanceof TextTile) return new ContentPos(next, pos - off, pos)
          parent = next
          index = 0
          off += next.boundary
        } else {
          if (index == parent.children.length)
            throw new Error(`Invalid position ${pos} in document of size ${this.length}`)
          index++
          off += next.length
        }
      }
    }
  }

  posFromDOM(dom: Node, offset: number, bias: -1 | 1 = -1) {
    let elt = this.nearest(dom)
    if (!elt)
      return this.dom.compareDocumentPosition(dom) | window.Node.DOCUMENT_POSITION_FOLLOWING ? this.length : 0
    return elt.localPosFromDOM(dom, offset, bias)
  }

  connect() {
    // FIXME
  }

  disconnect() {
    // FIXME must determine disconnected elements during update
  }
}

export class EltTile extends CompositeTile {
  declare dom: HTMLElement
  declare parent: CompositeTile

  constructor(readonly elt: Elt, readonly tag: Tag | null, flags: number, dom: HTMLElement) {
    super(dom, flags)
    // FIXME get correct length for non-leaf atoms
    this.length = tag && tag.isAtom() ? 1 : 2 * this.boundary
  }

  get isSpanning() { return this.elt.spanning }

  get isNodeOuter() { return !!this.tag }

  get isAtom() { return !!this.tag && this.tag.isAtom() }

  get boundary() { return this.tag && !this.tag.isAtom() ? 1 : 0 }

  get contentTile(): EltTile | null {
    for (let ch of this.children) if (ch.isNodeInner && (ch as EltTile).elt.hasHole) return (ch as EltTile).contentTile
    return this.elt.hasHole ? this : null
  }

  static of(elt: Elt, tag: Tag | null, flags: number) {
    let dom = document.createElement(elt.tagName)
    for (let i = 0; i < elt.attrs.length;) dom.setAttribute(elt.attrs[i++], elt.attrs[i++])
    return new EltTile(elt, tag, flags, dom)
  }
}

export class WidgetTile extends Tile {
  constructor(readonly widget: Widget<any>, readonly node: WGNode | null, flags: TileFlag, length: number = 0, dom?: Node) {
    super(dom || widget.type.render(widget.value), flags)
    this.length = length
  }

  get isNodeOuter() { return !!this.node }

  get isAtom() { return true }

  get children() { return noChildren }
}

export class TextTile extends Tile {
  declare dom: Text

  constructor(public text: string, dom: Text) {
    super(dom, 0)
    this.length = text.length
  }

  get children() { return noChildren }

  get isText() { return true }
  get isNodeOuter() { return true }
  get isAtom() { return true }

  sync() {
    if (this.flags & TileFlag.Synced) return
    this.flags |= TileFlag.Synced
    if (this.dom.nodeValue != this.text) this.dom.nodeValue = this.text
  }

  toString() { return JSON.stringify(this.text) }

  static of(text: string) {
    return new TextTile(text, document.createTextNode(text))
  }
}

function buildFromShape(shape: Shape, node: WGNode | null, nodeInner = false) {
  if (shape instanceof Elt) {
    let outer = EltTile.of(shape, node && node.tag,
                           (nodeInner ? TileFlag.NodeInner : 0) | (node || shape.hasHole ? 0 : TileFlag.Point))
    for (let child of shape.children) outer.addChild(buildFromShape(child, null, nodeInner || !!node))
    return outer
  } else {
    return new WidgetTile(shape, node, node ? 0 as TileFlag : TileFlag.Point, node ? node.length : 0)
  }
}

function copyEltShape(tile: EltTile, tag: Tag | null): EltTile {
  let outer = new EltTile(tile.elt, tag, tile.flags, tile.dom)
  if (!tile.elt.hasHole) {
    for (let ch of tile.children) outer.addChild(copyShape(ch as EltTile | WidgetTile))
  }
  return outer
}

function copyWidgetShape(tile: WidgetTile, node: WGNode | null): WidgetTile {
  return new WidgetTile(tile.widget, node, tile.flags, tile.length, tile.dom)
}

function copyShape(tile: EltTile | WidgetTile): EltTile | WidgetTile {
  return tile instanceof EltTile ? copyEltShape(tile, tile.tag) : copyWidgetShape(tile, tile.node)
}

const noChildren: Tile[] = []

function rm(dom: Node): Node | null {
  let next = dom.nextSibling
  dom.parentNode!.removeChild(dom)
  return next
}

interface TileWalker {
  enter(tile: EltTile): void
  skip(tile: Tile, from: number, to: number): void
  leave(tile: EltTile): void
}

// Used to track the previous tree during an update.
class TilePointer {
  constructor(readonly tile: Tile, readonly index: number, readonly parent: TilePointer | null) {}

  walk(dist: number, side: -1 | 1, walker?: TileWalker) {
    let {tile, index, parent} = this, nodeBoundary = 0 // 1=entering, 2=leaving FIXME properly handle atoms at node start/end
    for (;;) {
      if (!dist && side < 0) break
      if (tile.isText) {
        if (!dist) break
        let left = tile.length - index
        if (dist >= left) {
          dist -= left
          if (left && walker) walker.skip(tile, index, tile.length)
          ;({tile, index, parent} = parent!)
          index++
        } else {
          if (walker) walker.skip(tile, index, index + dist)
          index += dist
          dist = 0
        }
      } else if (index == tile.children.length) {
        if (!dist && (tile.isDoc || nodeBoundary != 2 && tile.isNode)) break
        if (walker) walker.leave(tile as EltTile)
        nodeBoundary = tile.isNodeInner ? 2 : 0
        dist -= tile.boundary
        ;({tile, index, parent} = parent!)
        index++
      } else {
        let next = tile.children[index]
        if (next.length <= dist) {
          if (walker) walker.skip(next, 0, next.length)
          dist -= next.length
          index++
          if (!next.isNodeInner) nodeBoundary = 0
        } else {
          if (next.isNode && (!dist || next.isAtom && !next.isText)) break
          if (walker && !next.isText) walker.enter(next as EltTile)
          dist -= next.boundary
          parent = tile == this.tile && index == this.index ? this : new TilePointer(tile, index, parent)
          tile = next
          index = 0
          nodeBoundary = next.isNode ? 1 : 0
        }
      }
    }
    return tile == this.tile && index == this.index ? this : new TilePointer(tile, index, parent)
  }

  tileAfter() {
    let {tile, index} = this
    return index < tile.children.length ? tile.children[index] : null
  }

  matchingWrapper(elt: Elt, reuse: Set<Tile>) {
    let best: EltTile | undefined, bestScore = 0
    let start = this.tile.isText ? this.parent! : this
    for (let {tile, parent} = start; !(tile.isNode || tile.isDoc); {tile, parent} = parent!) {
      let wrap = tile as EltTile
      if (reuse.has(wrap) || wrap.elt.tagName != elt.tagName || wrap.elt.spanning != elt.spanning) continue
      let score = compareAttributes(wrap.elt.attrs, elt.attrs)
      if (!best || bestScore < score) {
        best = wrap
        bestScore = score
      }
    }
    if (!best) return null
    if (bestScore < 0) updateAttributes(best.dom, best.elt.attrs, elt.attrs)
    reuse.add(best)
    return best.dom
  }

  matchingWidget(widget: Shape, reuse: Set<Tile>) {
    let {index, tile, parent} = this
    for (;;) {
      if (!index) {
        if (!parent || (tile instanceof EltTile ? tile.tag : !(tile instanceof TextTile))) break
        ;({index, tile, parent} = parent)
      } else {
        if (tile instanceof TextTile) break
        let before = tile.children[--index]
        if (!before.isPoint) break
        if (!reuse.has(before) && (widget instanceof Widget
              ? before instanceof WidgetTile && before.widget.eq(widget)
              : before instanceof EltTile && before.elt.eq(widget)))
          return before
      }
    }
    return null
  }

  get wrappers() {
    let result: Elt[] | null = null
    let start = this.tile.isText ? this.parent! : this
    for (let {tile, parent} = start; !tile.isNode && !tile.isDoc; {tile, parent} = parent!) {
      ;(result || (result = [])).push((tile as EltTile).elt)
    }
    return result ? result.reverse() : none
  }
}

const none: readonly any[] = []

class ContentUpdate {
  old: TilePointer
  new: CompositeTile
  // Current position in the new document
  posB = 0
  reused = new Set<Tile>()

  constructor(readonly state: EditorState, old: DocTile, readonly deco: DecoIterator) {
    this.old = new TilePointer(old, 0, null)
    this.new = new DocTile(state, old.dom as HTMLElement)
    // FIXME pre-allocate walkers?
  }

  keep(len: number, bound: Bound) {
    let walker: TileWalker = {
      enter: tile => {
        let span = tile.isSpanning && this.enterSpanning(tile.elt)
        if (span) {
          this.new = span
        } else {
          this.reused.add(tile)
          let inner = new EltTile(tile.elt, tile.tag, tile.flags, tile.dom)
          this.new.addChild(inner)
          this.new = inner
        }
      },
      leave: tile => {
        this.up()
      },
      skip: (tile, from, to) => {
        if (!(tile instanceof TextTile)) {
          this.new.addChild(tile)
        } else if (this.new.lastChild instanceof TextTile) {
          this.addText(tile.text.slice(from, to))
        } else if (!from && to == tile.text.length) {
          this.new.addChild(tile)
        } else if (!this.reused.has(tile)) {
          this.reused.add(tile)
          this.new.addChild(new TextTile(tile.text.slice(from, to), tile.dom))
        } else {
          this.new.addChild(TextTile.of(tile.text.slice(from, to)))
        }
      }
    }
    if (!(bound & Bound.Start)) {
      this.old = this.old.walk(0, 1)
      this.openWrappers(this.old.wrappers, true)
    }
    this.old = this.old.walk(len, (bound & Bound.End) ? 1 : -1, walker)
    this.posB += len
  }

  replace(len: number, ins: number, bound: Bound) {
    let start = this.old.walk(0, 1), end = this.old = start.walk(len, 1)
    this.build(ins, false, start, end)
  }

  update(len: number, bound: Bound) {
    this.old = this.old.walk(0, 1)
    this.build(len, true)
  }

  build(len: number, reuse: boolean, startOld?: TilePointer, endOld?: TilePointer) {
    let start = this.posB, end = this.posB + len
    this.deco.walk(start, end, {
      enter: (tag, elt, wrappers) => {
        this.openWrappers(wrappers, reuse)
        let tile: EltTile | undefined
        if (reuse) {
          let nodeTile = this.old.tileAfter!
          if (nodeTile instanceof EltTile && !this.reused.has(nodeTile) &&
              nodeTile.elt.tagName == elt.tagName && nodeTile.elt.eqChildren(elt)) {
            this.reused.add(nodeTile)
            updateAttributes(nodeTile.dom, nodeTile.elt.attrs, elt.attrs)
            tile = copyEltShape(nodeTile, tag)
          }
        }
        if (!tile) {
          tile = EltTile.of(elt, tag, 0)
          for (let ch of elt.children) {
            tile.addChild(buildFromShape(ch, null)) // FIXME reuse inner shapes
          }
        }
        this.new.addChild(tile)
        this.new = tile.contentTile!
        if (!this.new) throw new Error("Non-atom node rendered without hole")
        if (reuse) this.old = this.old.walk(1, 1)
        this.posB++
      },
      leave: () => {
        this.leaveNode()
        if (reuse) this.old = this.old.walk(1, 1)
        this.posB++
      },
      node: (node, shape, wrappers) => {
        this.openWrappers(wrappers, reuse)
        let tile: Tile | undefined
        if (reuse || node.isText() && this.posB == start) {
          let nodeTile = this.old.tileAfter()!
          if (!this.reused.has(nodeTile)) {
            if (shape instanceof Elt && nodeTile instanceof EltTile &&
                nodeTile.elt.tagName == shape.tagName && nodeTile.elt.eqChildren(shape)) {
              this.reused.add(nodeTile)
              updateAttributes(nodeTile.dom, nodeTile.elt.attrs, shape.attrs)
              tile = copyEltShape(nodeTile, node.tag)
            } else if (node.isText() && nodeTile instanceof TextTile && !(this.new.lastChild instanceof TextTile) &&
                       (reuse || this.posB == start)) {
              this.reused.add(nodeTile)
              if (nodeTile.text != node.text) {
                nodeTile.dom.nodeValue = node.text
                tile = new TextTile(node.text, nodeTile.dom)
              } else {
                tile = nodeTile
              }
            } else if (shape instanceof Widget && nodeTile instanceof WidgetTile &&
                       nodeTile.widget.eq(shape)) {
              tile = copyWidgetShape(nodeTile, node)
            }
          }
        }
        if (!tile) {
          if (node.isText()) this.addText(node.text!)
          else tile = buildFromShape(shape, node)
        }
        if (tile) this.new.addChild(tile)
        for (let _ of wrappers) this.up()
        if (reuse) this.old = this.old.walk(node.length, 1)
        this.posB += node.length
      },
      widget: (widget, side) => { // FIXME don't pass side here
        let found = reuse ? this.old.matchingWidget(widget, this.reused)
          : startOld && this.posB == start ? startOld.matchingWidget(widget, this.reused)
          : endOld && this.posB == end ? endOld.matchingWidget(widget, this.reused)
          : null
        this.new.addChild(found || buildFromShape(widget, null))
      }
    })
  }

  up() {
    if (this.new instanceof EltTile && this.new.tag && this.new.tag.isTextblock()) {
      let i = this.new.children.length - 1
      let last = i < 0 ? null : this.new.children[i]
      if (last instanceof WidgetTile && last.widget.type == brHack.type) {
        let prev = i ? this.new.children[i - 1] : null
        if (prev && prev.dom.nodeName != "BR")
          this.new.children.pop()
      } else if (!last || last.dom.nodeName == "BR") {
        this.new.addChild(buildFromShape(brHack, null, true))
      }
    }
    this.new = this.new.parent!
  }

  leaveNode() {
    for (let inNode = true;;) {
      if (!inNode && (this.new.isNode || this.new.isDoc)) break
      if (inNode && this.new.isNodeOuter) inNode = false
      this.up()
    }
  }

  openWrappers(wrappers: readonly Elt[], reuse: boolean) {
    for (let elt of wrappers) {
      let span = elt.spanning && this.enterSpanning(elt)
      if (span) {
        this.new = span
      } else {
        let match = reuse && this.old.matchingWrapper(elt, this.reused)
        let tile = match ? new EltTile(elt, null, 0, match) : EltTile.of(elt, null, 0)
        this.new.addChild(tile)
        this.new = tile
      }
    }
  }

  enterSpanning(elt: Elt) {
    let cur = this.new
    for (let i = cur.children.length - 1; i >= 0; i--) {
      let prev = cur.children[i] as EltTile
      if (prev.isPoint) continue
      if (!prev.isSpanning || !prev.elt.eq(elt)) break
      // If this is a node from the old tree, copy it
      if (prev.flags & TileFlag.Synced) {
        let copy = cur.children[i] = new EltTile(elt, null, prev.flags, prev.dom)
        for (let ch of prev.children) copy.addChild(ch)
        prev = copy
        prev.parent = cur
      }
      // Move any point tiles after the wrapper into it
      for (let j = i + 1; j < cur.children.length; j++) prev.addChild(cur.children[j])
      cur.children.length = i + 1
      return prev
    }
    return null
  }

  addText(text: string) {
    let last = this.new.lastChild
    if (!(last instanceof TextTile)) {
      this.new.addChild(TextTile.of(text))
    } else if (last.flags & TileFlag.Synced) {
      this.new.children.pop()
      this.new.addChild(this.reused.has(last) ? TextTile.of(last.text + text) : new TextTile(last.text + text, last.dom))
      this.reused.add(last)
    } else {
      last.text += text
      last.length += text.length
    }
  }

  finish() {
    while (!(this.new instanceof DocTile)) this.up()
    this.new.sync()
    return this.new as DocTile
  }
}

function updateAttributes(dom: HTMLElement, a: Attributes, b: Attributes) {
  for (let iA = 0, iB = 0;;) {
    if (iA < a.length && iB < b.length && a[iA] == b[iB]) {
      if (a[iA + 1] != b[iB + 1]) dom.setAttribute(b[iB], b[iB + 1])
      iA += 2; iB += 2
    } else if (iA < a.length && (iB == b.length || a[iA] < b[iB])) {
      dom.removeAttribute(a[iA])
      iA += 2
    } else if (iB < b.length && iA < a.length) {
      dom.setAttribute(b[iB], b[iB + 1])
      iB += 2
    } else {
      break
    }
  }
}

const brHack = Widget.create({
  render() { return document.createElement("br") }
})
