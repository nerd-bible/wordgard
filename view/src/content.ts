import {Node as WGNode, Tag, ChangeDesc} from "@wordgard/doc"
import {EditorState} from "@wordgard/state"
import {Shape} from "./shape"
import {DecoIterator, findChangedRanges} from "./decoration"
import {Elt, Widget} from "./shape"
import {compareAttributes, Attributes} from "./shape"

declare global {
  interface Node { wsElt?: Tile }
}

// FIXME does having these still make sense?
export const enum TileFlag {
  NodeInner = 1,
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

  constructor(readonly dom: Node, readonly flags: number) {
    dom.wsElt = this
  }

  get isAtom() { return false }
  get isNodeOuter() { return false }
  get isNodeInner() { return (this.flags & TileFlag.NodeInner) > 0 }
  get isNode() { return this.isNodeOuter || (this.flags & TileFlag.NodeInner) > 0 }
  get isText() { return false }
  get isDoc() { return false }
  get isSpanning() { return false }

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
}

export class CompositeTile extends Tile {
  children: Tile[] = []

  addChild(child: Tile) {
    this.children.push(child)
    child.parent = this
    this.length += child.length
  }

  addText(text: string) {
    if (this.lastChild instanceof TextTile) this.lastChild.addText(text)
    else this.addChild(TextTile.of(text))
  }
}

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

  // FIXME draw placeholder <br>s
  updateRanges(state: EditorState, sections: readonly number[]) {
    if (sections.length == 2 && sections[1] == -1) return this
    let builder = new ContentUpdate(state, this, new DecoIterator(state))
    for (let i = 0; i < sections.length;) {
      let len = sections[i++], ins = sections[i++]
      if (ins == -1) {
        builder.keep(len, i == sections.length)
      } else if (ins == -2) {
        builder.update(len)
      } else {
        builder.replace(len, ins)
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

function syncChildren(tile: CompositeTile) {
  let prev: Node | null = null, next: Node | null = tile.dom.firstChild
  for (let child of tile.children) {
    if (child.dom.parentNode == tile.dom) {
      while (next && next != child.dom) next = rm(next)
    } else {
      tile.dom.insertBefore(child.dom, next)
    }
    prev = child.dom
    next = prev.nextSibling
  }
  while (next) next = rm(next)
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
  constructor(readonly widget: Widget<any>, readonly node: WGNode | null, length: number = 0, dom?: Node) {
    super(dom || widget.type.render(widget.value), 0)
    this.length = length
  }

  get isNodeOuter() { return !!this.node }

  get isAtom() { return true }

  get children() { return noChildren }
}

export class TextTile extends Tile {
  constructor(public text: string, dom: Text) {
    super(dom, 0)
    this.length = text.length
  }

  get children() { return noChildren }

  get isText() { return true }
  get isNodeOuter() { return true }
  get isAtom() { return true }

  addText(text: string) {
    this.text += text
    this.length += text.length
    this.dom.nodeValue = this.text
  }

  toString() { return JSON.stringify(this.text) }

  static of(text: string) {
    return new TextTile(text, document.createTextNode(text))
  }
}

function buildFromShape(shape: Shape, node: WGNode | null, nodeInner = false) {
  if (shape instanceof Elt) {
    let outer = EltTile.of(shape, node && node.tag, nodeInner ? TileFlag.NodeInner : 0)
    for (let child of shape.children) outer.addChild(buildFromShape(child, null, nodeInner || !!node))
    return outer
  } else {
    return new WidgetTile(shape, node, node ? node.length : 0)
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
  return new WidgetTile(tile.widget, node, tile.flags, tile.dom)
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

interface ContentWalker {
  enter(tile: EltTile): void
  skip(tile: Tile, parent: Tile | null): void
  leave(tile: EltTile): void
}

const enum Alignment { WrapStart, NodeStart }

// Used to track the previous tree during an update.
class ViewTreePointer {
  constructor(readonly tile: Tile, readonly index: number, readonly parent: ViewTreePointer | null) {}

  walk(dist: number, side: -1 | 1, walker?: ContentWalker, align?: Alignment) {
    let {tile, index, parent} = this, nodeBoundary = 0 // 1=entering, 2=leaving
    if (align) console.log("Align to", align, "start from", tile, index)
    for (;;) {
      if (align) console.log("going", tile, index)
      if (tile.isText) {
        if (!dist) break
        if (align == Alignment.NodeStart || align == Alignment.WrapStart) break
        let left = tile.length - index
        if (dist >= left) {
          dist -= left
          if (left && walker)
            walker.skip(index ? TextTile.of((tile as TextTile).text.slice(index)) : tile, tile.parent)
          ;({tile, index, parent} = parent!)
          index++
        } else {
          if (walker)
            walker.skip(TextTile.of((tile as TextTile).text.slice(index, index + dist)), tile.parent)
          index += dist
          dist = 0
        }
      } else if (index == tile.children.length) {
        if (!dist && (tile.isDoc || nodeBoundary != 2 && tile.isNode || side < 0 && tile.isSpanning)) break
        if (walker) walker.leave(tile as EltTile)
        nodeBoundary = tile.isNodeInner ? 2 : 0
        dist -= tile.boundary
        ;({tile, index, parent} = parent!)
        index++
      } else {
        let next = tile.children[index]
        if ((align == Alignment.NodeStart || align == Alignment.WrapStart) && next.isNodeOuter) break
        if (align == Alignment.WrapStart && !next.isNode && next.length) break
        if (next.length <= dist && !align) {
          if (!dist && !next.length && // Non-node widget
              (next.isNodeInner ? nodeBoundary : side < 0))
            break
          if (walker) walker.skip(next, next.parent)
          dist -= next.length
          index++
          if (!next.isNodeInner) nodeBoundary = 0
        } else {
          if (next.isNode && !next.isText && (!dist || next.isAtom)) break
          if (!dist && next.isSpanning && side < 0) break
          if (walker && !next.isText) walker.enter(next as EltTile)
          dist -= next.boundary
          parent = tile == this.tile && index == this.index ? this : new ViewTreePointer(tile, index, parent)
          tile = next
          index = 0
          nodeBoundary = next.isNode ? 1 : 0
        }
      }
    }
    return tile == this.tile && index == this.index ? this : new ViewTreePointer(tile, index, parent)
  }

  align(to: Alignment) {
    return this.walk(1e8, 1, undefined, to)
  }

  tileAfter() {
    let {tile, index} = this
    return index < tile.children.length ? tile.children[index] : null
  }

  wrappersHere() { // FIXME return spanning parents?
    let {tile, index} = this
    let found: EltTile[] | undefined
    for (; index < tile.children.length;) {
      let next = tile.children[index]
      if (next.isNode || !(next instanceof EltTile)) break
      ;(found || (found = [])).push(next)
      tile = next
      index = 0
    }
    return found || none
  }
}

const none: readonly any[] = []

function syncParents(tile: Tile, nodeDepth: number, targetDepth: number, walker: ContentWalker) {
  if (tile.isNodeOuter || tile.isDoc) {
    if (nodeDepth <= targetDepth) return
    nodeDepth--
  }
  syncParents(tile.parent!, nodeDepth, targetDepth, walker)
  if (tile instanceof EltTile) walker.enter(tile)
}

class ContentUpdate {
  old: ViewTreePointer
  new: CompositeTile
  // Current position in the new document
  posB = 0
  reused = new Set<Tile>()

  constructor(readonly state: EditorState, old: DocTile, readonly deco: DecoIterator) {
    this.old = new ViewTreePointer(old, 0, null)
    this.new = new DocTile(state, old.dom as HTMLElement)
    // FIXME pre-allocate walkers?
  }

  keep(len: number, last: boolean) {
    let cur = this.new
    let walker: ContentWalker = {
      enter(node) {
        if (node.isSpanning && cur.lastChild?.isSpanning && node.elt.eq((cur.lastChild as EltTile).elt)) {
          cur = cur.lastChild as EltTile
        } else {
          let inner = new EltTile(node.elt, node.tag, node.flags, node.dom)
          cur.addChild(inner)
          cur = inner
        }
      },
      leave(n) {
        if (cur instanceof EltTile) syncChildren(cur)
        cur = cur.parent!
      },
      skip(node) {
        if (node instanceof TextTile) cur.addText(node.text)
        else cur.addChild(node)
      }
    }
    syncParents(this.old.tile, this.old.tile.depth, cur.depth, walker)
    this.old = this.old.walk(len, last ? 1 : -1, walker)
    this.new = cur
    this.posB += len
  }

  replace(len: number, ins: number) {
    this.build(ins, false)
    this.old = this.old.walk(len, 1)
  }

  update(len: number) { // FIXME need a last flag?
    this.build(len, true)
    this.old = this.old.walk(0, 1)
  }

  build(len: number, reuse: boolean) {
    this.deco.walk(this.posB, this.posB + len, {
      enter: (tag, elt, wrappers) => {
        if (reuse) this.old = this.old.align(Alignment.WrapStart)
        this.openWrappers(wrappers, reuse)
        let tile: EltTile | undefined
        if (reuse) {
          this.old = this.old.align(Alignment.NodeStart)
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
        if (reuse) this.old = this.old.walk(1, -1)
      },
      leave: () => {
        this.leaveNode()
        if (reuse) this.old = this.old.walk(1, -1)
      },
      node: (node, shape, wrappers) => {
        if (reuse) this.old = this.old.align(Alignment.WrapStart)
        this.openWrappers(wrappers, reuse)
        let tile: Tile | undefined
        if (reuse) {
          this.old = this.old.align(Alignment.NodeStart)
          let nodeTile = this.old.tileAfter()!
          if (!this.reused.has(nodeTile)) {
            if (shape instanceof Elt && nodeTile instanceof EltTile &&
                nodeTile.elt.tagName == shape.tagName && nodeTile.elt.eqChildren(shape)) {
              this.reused.add(nodeTile)
              updateAttributes(nodeTile.dom, nodeTile.elt.attrs, shape.attrs)
              tile = copyEltShape(nodeTile, node.tag)
            } else if (node.isText() && nodeTile instanceof TextTile && nodeTile.text == node.text &&
                       !(this.new.lastChild instanceof TextTile)) {
//              tile = nodeTile FIXME
            } else if (shape instanceof Widget && nodeTile instanceof WidgetTile &&
                       nodeTile.widget.eq(shape)) {
              tile = copyWidgetShape(nodeTile, node)
            }
          }
        }
        if (!tile) {
          if (node.isText()) this.new.addText(node.text!)
          else tile = buildFromShape(shape, node)
        }
        if (tile) this.new.addChild(tile)
        for (let _ of wrappers) this.up()
        if (reuse) this.old = this.old.walk(node.length, -1)
      },
      widget: (widget, side) => { // FIXME store side
        this.new.addChild(buildFromShape(widget, null))
      }
    })
    this.posB += len
  }

  up() {
    // FIXME this will run multiple times for spanning nodes
    syncChildren(this.new)
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
    let reusable = reuse ? this.old.wrappersHere() : none
    for (let elt of wrappers) {
      if (elt.spanning && this.new.lastChild?.isSpanning && elt.eq((this.new.lastChild as EltTile).elt)) {
        this.new = this.new.lastChild as EltTile
      } else {
        let match = reuse && matchingWrapper(elt, reusable, this.reused)
        let tile = match ? new EltTile(elt, null, 0, match) : EltTile.of(elt, null, 0)
        this.new.addChild(tile)
        this.new = tile
      }
    }
  }

  finish() {
    while (!(this.new instanceof DocTile)) this.up()
    syncChildren(this.new)
    return this.new as DocTile
  }
}

function matchingWrapper(elt: Elt, wrappers: readonly EltTile[], reuse: Set<Tile>) {
  let best: EltTile | undefined, bestScore = 0
  for (let wrap of wrappers) {
    if (wrap.elt.tagName == elt.tagName && wrap.elt.spanning == elt.spanning && !reuse.has(wrap)) {
      let score = compareAttributes(wrap.elt.attrs, elt.attrs)
      if (!best || bestScore < score) {
        best = wrap
        bestScore = score
      }
    }
  }
  if (!best) return null
  if (bestScore < 0) updateAttributes(best.dom, best.elt.attrs, elt.attrs)
  reuse.add(best)
  return best.dom
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
