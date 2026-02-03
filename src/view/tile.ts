import {Plot, Node, Mark, Leaf, compareAttributes, Elt, ChangeSet, Attributes,
        pushAttribute, noAttributes} from "wordgard/doc"
import {EditorState, Direction, TextblockMap, BidiSpan} from "wordgard/state"
import {findClusterBreak} from "@marijn/find-cluster-break"
import {Widget, TextWidget, DecoElt, Shape, DecoIterator, findChangedRanges, WrapperSource,
        renderWrapper, renderMarkWrapper} from "./decoration"
import {eqArray} from "./util"
import {textRange, singleRect, DOMNode, rmDOM} from "./dom"
import {type CompositionInfo} from "./input"
import {type EditorView} from "./editorview"

const LOG_update = false

export const enum TileFlag {
  NodeInner = 1,
  Spanning = 2,
  Point = 4,
  PointBefore = 8,
  PointAfter = 16,
  PointSide = PointBefore | PointAfter,
  Composition = 32,
  Synced = 64,
  Atom = 128, // Composite tile whose length isn't determined by child length
}

const enum Orientation { Row, Col }

const enum PosAssocFlag {
  AssocMask = 3,
  VertOutside = 4
}

class PosAssoc {
  readonly flags: PosAssocFlag
  constructor(readonly pos: number, assoc: -1 | 0 | 1, vertOutside?: boolean) {
    this.flags = (assoc + 1) | (vertOutside ? PosAssocFlag.VertOutside : 0)
  }
  get assoc(): -1 | 0 | 1 { return ((this.flags & PosAssocFlag.AssocMask) - 1) as -1 | 0 | 1 }
  get vertOutside() { return (this.flags & PosAssocFlag.VertOutside) > 0 }
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

  constructor(public dom: HTMLElement | Text, flags: number) {
    this.flags = flags & ~TileFlag.Synced
    dom.wgTile = this
  }

  get isAtom() { return false }
  get isNodeOuter() { return false }
  get isNodeInner() { return (this.flags & TileFlag.NodeInner) > 0 }
  get isNode() { return this.isNodeOuter || (this.flags & TileFlag.NodeInner) > 0 }
  get isText() { return false }
  get isDoc() { return false }
  get isSpanning() { return false }
  get isComposition() { return (this.flags & TileFlag.Composition) > 0 }
  get isPoint() { return (this.flags & TileFlag.Point) > 0 }
  get node(): Node | null { return null }

  posBeforeChild(child: Tile, ownStart = this.posAtStart): number {
    for (let i = 0, pos = ownStart;; i++) {
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

  // FIXME include side in output?
  localPosFromDOM(dom: DOMNode, offset: number, bias: -1 | 1): number {
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
      while (domBefore && !((elt = domBefore.wgTile) && elt.parent == this as Tile))
        domBefore = domBefore.previousSibling
      return domBefore ? this.posBeforeChild(elt!) + elt!.length : this.posAtStart
    }
    // Otherwise, use various heuristics, falling back on the bias
    // parameter, to determine whether to return the position at the
    // start or at the end of this content element.
    if (this.dom && this.dom != dom) {
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

  handleEvent(event: Event, view: EditorView) { return false }

  get ignoreMutations() { return false }

  toString() { return this.dom.nodeName + (this.children.length ? `(${this.children})` : "") }

  sync() {}

  destroyDropped(reused: Map<Tile, Reused>) {
    if (reused.get(this) != Reused.Full) {
      this.destroy()
      for (let ch of this.children) ch.destroyDropped(reused)
    }
  }

  destroy() {}

  nearestNode() {
    let tile: Tile = this
    while (!tile.node) tile = tile.parent!
    return tile
  }

  // FIXME needs a lot of tests
  posAtCoords(state: EditorState, x: number, y: number): PosAssoc {
    let nodeTile = this.nearestNode()
    return nodeTile.posAtCoordsInner(nodeTile.posAtStart, state, x, y, null, Orientation.Col)
  }

  abstract posAtCoordsInner(start: number, state: EditorState, x: number, y: number, textblock: TextblockMap | null,
                            orientation: Orientation): PosAssoc

  static get(node: DOMNode) { return node.wgTile }
}

export class CompositeTile extends Tile {
  children: Tile[] = []
  declare dom: HTMLElement

  addChild(child: Tile) {
    if (this.flags & TileFlag.Synced) throw new Error("Cannot add to a synced tile")
    this.children.push(child)
    child.parent = this
  }

  sync() {
    if (this.flags & TileFlag.Synced) return
    this.flags |= TileFlag.Synced
    let len = this.boundary * 2
    for (let ch of this.children) {
      ch.sync()
      len += ch.length
    }
    if (!(this.flags & TileFlag.Atom)) this.length = len
    this.syncChildren()
  }

  syncChildren() {
    let prev: DOMNode | null = null, next: ChildNode | null = this.dom.firstChild
    for (let child of this.children) {
      if (child.dom.parentNode == this.dom) {
        while (next && next != child.dom) next = rmDOM(next)
      } else {
        this.dom.insertBefore(child.dom, next)
      }
      prev = child.dom
      next = prev.nextSibling
    }
    while (next) next = rmDOM(next)
  }

  posAtCoordsInner(start: number, state: EditorState, x: number, y: number, textblock: TextblockMap | null,
                   orientation: Orientation): PosAssoc {
    let {node} = this, outerOrientation = orientation
    if (node && node.isPlot) {
      orientation = node.type.orientation == "row" ? Orientation.Row : Orientation.Col
      if (node.isTextblock) {
        textblock = TextblockMap.get(start, state.doc.nodeAt(start - 1) as Plot, state.textDirection(node.tag))
      } else if (node.isBlock) {
        textblock = null
      }
    }
    let result = this.isAtom || !this.children.length ? null
      : orientation == Orientation.Col ? this.posAtCoordsCol(start, state, x, y, textblock)
      : this.posAtCoordsRow(start, state, x, y, textblock)
    if (result) return result
    let rect = this.dom.getBoundingClientRect()
    let after = outerOrientation == Orientation.Row ? x > (rect.left + rect.right) / 2 : y > (rect.top + rect.bottom) / 2
    return new PosAssoc(start + (after ? this.length : 0), after ? -1 : 1)
  }

  posAtCoordsRow(start: number, state: EditorState, x: number, y: number, textblock: TextblockMap | null): PosAssoc | null {
    let scan = new RowScan<Tile>(x, y)
    for (let child of this.children) {
      if (child.isPoint) continue
      let rects, {dom} = child
      if (dom.nodeType == 1) rects = (dom as HTMLElement).getClientRects()
      else if (dom.nodeType == 3) rects = textRange(dom as Text, 0, dom.nodeValue!.length).getClientRects()
      else continue
      for (let i = 0; i < rects.length; i++) scan.rect(rects[i], child)
      if (scan.done) break
    }
    if (!scan.closest) return null
    let closest = scan.closest, rect = scan.closestRect!
    let pos = this.posBeforeChild(closest, start)
    if (scan.dyClosest) { // Coords are vertically outside of the child
      if (y > rect.bottom) return new PosAssoc(pos + closest.length, -1, true)
      else return new PosAssoc(pos, 1, true)
    }
    return closest.posAtCoordsInner(pos + closest.boundary, state,
                                    x, Math.max(rect!.top, Math.min(rect!.bottom, y)),
                                    textblock, Orientation.Row)
  }

  posAtCoordsCol(
    start: number, state: EditorState, x: number, y: number, textblock: TextblockMap | null
  ): PosAssoc {
    let lastBot = -1
    for (let child of this.children) {
      if (child.isPoint || child.dom.nodeType != 1) continue
      let rect = (child.dom as HTMLElement).getBoundingClientRect()
      if (rect.top > y) return new PosAssoc(this.posBeforeChild(child, start), y > (lastBot + rect.top) / 2 ? 1 : -1)
      if (rect.bottom >= y) return child.posAtCoordsInner(this.posBeforeChild(child, start) + child.boundary, state,
                                                          x, y, textblock, Orientation.Col)
    }
    return new PosAssoc(start + this.length - 2 * this.boundary, -1)
  }
}

// Algorithm for posAtCoords in row-layout elements (textblocks, block
// containers with orientation=row, and text nodes). Locates the
// closest element to the coordinates, prioritizing y closeness, and
// organizing things that overlap vertically into rows, conceptually
// expanding their height to the full height of the row.
class RowScan<T> {
  dxClosest = 1e9
  dyClosest = 1e9
  closest: T | null = null
  closestRect: DOMRect | null = null
  rowTop: number
  rowBot: number

  constructor(readonly x: number, readonly y: number) {
    this.rowTop = this.rowBot = y
  }

  rect(rect: DOMRect, value: T) {
    let {x, y} = this
    let dx = rect.left > x ? rect.left - x : rect.right < x ? x - rect.right : 0
    let dy = rect.top > y ? rect.top - y : rect.bottom < y ? y - rect.bottom : 0
    if (rect.top <= this.rowBot && rect.bottom >= this.rowTop) {
      // Rectangle is in the current row
      this.rowTop = Math.min(rect.top, this.rowTop)
      this.rowBot = Math.max(rect.bottom, this.rowBot)
      dy = 0
    }
    if (this.closest == null || (dy - this.dyClosest || dx - this.dxClosest) < 0) {
      if (this.closest && this.dyClosest && this.dxClosest < dx &&
          this.closestRect!.top <= this.rowBot - 2 && this.closestRect!.bottom >= this.rowTop + 2) {
        // Retroactively set dy to 0 if the current match is in this row.
        this.dyClosest = 0
      } else {
        this.closest = value
        this.dxClosest = dx
        this.dyClosest = dy
        this.closestRect = rect
      }
    }
  }

  get done() { return !this.dxClosest && !this.dyClosest }
}

export function dirAt(state: EditorState, pos: number, assoc: -1 | 1, textblock?: TextblockMap | null) {
  if (textblock === undefined) {
    let {textblockParent: block} = state.doc.resolve(pos)
    textblock = block ? TextblockMap.get(block.start, block.node, state.textDirection()) : null
  }
  if (!textblock) return state.textDirection()
  let found = BidiSpan.find(textblock.order, pos - textblock.start, assoc)
  return textblock.order[found].dir
}

export class DocTile extends CompositeTile {
  declare dom: HTMLElement

  constructor(public state: EditorState, dom: HTMLElement, readonly cursorWrapper: readonly Mark<any>[] | null) {
    super(dom, 0)
  }

  static create(state: EditorState, dom: HTMLElement) {
    return new DocTile(state, dom, null).updateRanges(state, [0, state.doc.length])
  }

  get isDoc() { return true }

  get node() { return this.state.doc }

  update(state: EditorState, changes: ChangeSet.Sections, composition?: CompositionInfo | null) {
    return this.updateRanges(state, findChangedRanges(this.state, state, changes), composition)
  }

  updateRanges(state: EditorState, sections: ChangeSet.Sections, composition?: CompositionInfo | null) {
    let wrapper = composition?.wrapCursor || null
    if ((!sections.length || sections.length == 2 && sections[1] == -1) && eqArray(wrapper, this.cursorWrapper))
      return this
    LOG_update && console.log(`updateRanges(${state.doc},`, sections, composition, ")")
    if (composition) {
      let separated = separateComposition(sections, composition)
      LOG_update && !separated && console.log("separateComposition failed")
      if (!separated) composition = null
      else sections = separated
    }
    let builder = new ContentUpdate(state, this, new DecoIterator(state), wrapper)
    for (let i = 0, posA = 0, startCovered = false; i < sections.length;) {
      let len = sections[i++], ins = sections[i++]
      LOG_update && console.log("section", len, ins, "new=" + builder.new, "old=" + builder.old.tile, "@", builder.old.index)
      if (composition && posA == composition.fromA && ins >= 0) {
        LOG_update && console.log("(composition)")
        if (!startCovered) builder.update(0, false)
        builder.composition(composition!)
        if (ins && (startCovered = i == sections.length || sections[i + 1] == -1)) builder.update(0, false)
      } else if (ins == -1) {
        builder.keep(len, !startCovered, i == sections.length)
        startCovered = false
      } else if (ins == -2) {
        builder.update(len, !startCovered)
        startCovered = true
      } else {
        builder.replace(len, ins, !startCovered)
        startCovered = true
      }
      posA += len
    }
    let result = builder.finish()
    result.sync()
    for (let ch of this.children) ch.destroyDropped(builder.reused)
    LOG_update && console.log("/updateRanges " + result + " : " + result.dom.innerHTML)
    return result
  }

  nearest(dom: DOMNode, requireTag = false) {
    for (let cur: DOMNode | null = dom; cur; cur = cur.parentNode) {
      let elt = cur.wgTile
      if (elt && (!requireTag || elt.node) && this.owns(elt)) return elt
    }
    return null
  }

  owns(elt: Tile) {
    for (;;) {
      if (elt == this) return true
      let {parent} = elt
      if (!parent) return false
      elt = parent
    }
  }

  resolve(pos: number, assoc: -1 | 0 | 1 = 0) {
    let found: Tile | undefined, foundDepth = 0, offset = 0
    let scan = (tile: Tile, off: number, depth: number) => {
      for (let i = 0;; i++) {
        if (!off && (!found || assoc > 0 || !assoc && foundDepth > depth)) { found = tile; offset = i; foundDepth = depth }
        if (i == tile.children.length) break
        let ch = tile.children[i]
        if (ch.isPoint && !off) {
          if (ch.flags & TileFlag.PointBefore) found = undefined
          else if ((ch.flags & TileFlag.PointAfter) || assoc < 0) return true
        }
        if (ch.boundary ? off && off < ch.length : off <= ch.length) {
          if (ch.isText && (!off ? assoc > 0 : off == ch.length ? assoc < 0 : true)) {
            found = ch; offset = off; foundDepth = depth + 1
          } else if (!ch.isAtom && scan(ch, off - ch.boundary, depth + 1)) {
            return true
          }
        }
        off -= ch.length
        if (off < 0) return true
      }
      return false
    }
    scan(this, pos, 0)
    if (!found) throw new Error(`Failed to resolve ${pos} in doc of size ${this.length}`)
    return new ContentPos(found, offset, pos)
  }

  posFromDOM(dom: DOMNode, offset: number, bias: -1 | 1 = -1) {
    let elt = this.nearest(dom)
    if (!elt)
      return this.dom.compareDocumentPosition(dom) & 4 /* following */ ? this.length : 0
    return elt.localPosFromDOM(dom, offset, bias)
  }

  posBeforeDOM(dom: DOMNode) {
    let tile = this.nearest(dom)
    if (!tile) return null
    let pos = tile.posAtStart
    if (tile.dom != dom) for (let ch of tile.children) {
      if (ch.dom.compareDocumentPosition(dom) & 2 /* preceding */) break
      pos += ch.length
    }
    return pos
  }

  coordsForElement(pos: number): DOMRect | null {
    let r = this.resolve(pos, 1)
    if (r.tile instanceof TextTile) return textTileRect(r.tile, r.offset)
    if (r.offset == r.tile.children.length) return null
    let after = r.tile.children[r.offset]
    if (after instanceof TextTile) return textTileRect(after, 0)
    if (after.dom.nodeType != 1) return null
    return (after.dom as HTMLElement).getBoundingClientRect()
  }
}

function textTileRect(tile: TextTile, offset: number) {
  return textRange(tile.dom, offset, findClusterBreak(tile.text, offset)).getBoundingClientRect()
}

export class EltTile extends CompositeTile {
  declare dom: HTMLElement
  declare parent: CompositeTile

  constructor(readonly elt: DecoElt, readonly _node: Node | null, flags: number, length: number, dom: HTMLElement) {
    super(dom, flags)
    this.length = length
  }

  get isSpanning() { return (this.flags & TileFlag.Spanning) > 0 }
  get isNodeOuter() { return !!this.node }
  get isAtom() { return !!this._node && (this.flags & TileFlag.Atom) > 0 }
  get boundary() { return this._node && !(this.flags & TileFlag.Atom) ? 1 : 0 }
  get node() { return this._node }

  get contentTile(): EltTile | null {
    for (let ch of this.children) if (ch.isNodeInner && (ch as EltTile).elt.hasContent) return (ch as EltTile).contentTile
    return this.elt.hasContent ? this : null
  }

  static of(elt: DecoElt, node: Node | null, flags: number, length: number, dom?: HTMLElement | null) {
    return new EltTile(elt, node, flags, length, dom || eltDOM(elt))
  }
}

function eltDOM(elt: DecoElt) {
  let dom = document.createElement(elt.tagName)
  for (let i = 0; i < elt.attrs.length;) dom.setAttribute(elt.attrs[i++], elt.attrs[i++])
  return dom
}

export class WidgetTile extends Tile {
  constructor(
    readonly widget: Widget<any>,
    readonly _node: Node | null,
    flags: TileFlag,
    length: number = 0,
    dom?: HTMLElement | Text
  ) {
    super(dom || widget.type.render(widget.value), flags)
    this.length = length
  }

  get isNodeOuter() { return !!this._node }
  get isAtom() { return true }
  get node() { return this._node }

  get children() { return noChildren }

  handleEvent(event: Event, view: EditorView) { return this.widget.type.handleEvent(event, view) }

  destroy() { this.widget.type.destroy(this.widget.value) }

  toString() { return this.widget.type == TextWidget ? JSON.stringify(this.widget.value) : super.toString() }

  posAtCoordsInner(start: number, state: EditorState, x: number, y: number,
                   textblock: TextblockMap | null, orientation: Orientation): PosAssoc {
    if (!this.node) return new PosAssoc(start, 0)
    let rect = this.dom.nodeType == 1 ? (this.dom as HTMLElement).getBoundingClientRect()
      : textRange(this.dom as Text, 0, this.length).getBoundingClientRect()
    let after = orientation == Orientation.Col ? y > (rect.top + rect.bottom) / 2
      : (x < (rect.left + rect.right) / 2) == (dirAt(state, start, 1, textblock) == Direction.LTR)
    return after ? new PosAssoc(start + this.length - 2 * this.boundary, -1) : new PosAssoc(start, 1)
  }
}

export class TextTile extends Tile {
  declare dom: Text

  constructor(public text: string, dom: Text, flags: TileFlag = 0 as TileFlag) {
    super(dom, flags)
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

  localPosFromDOM(dom: DOMNode, offset: number): number {
    return this.posAtStart + Math.min(offset, this.length)
  }

  posAtCoordsInner(start: number, state: EditorState, x: number, y: number,
                   textblock: TextblockMap | null, orientation: Orientation): PosAssoc {
    let scan = new RowScan<number>(x, y)
    for (let i = 0; i < this.length;) {
      let end = findClusterBreak(this.text, i)
      let rect = singleRect(textRange(this.dom, i, end), 1)
      if (rect.top == rect.bottom) continue
      scan.rect(rect, i)
      if (scan.done) break
      i = end
    }
    let closest = scan.closest!, rect = scan.closestRect!
    let pos = start + closest, dir = dirAt(state, pos, 1, textblock)
    let after = scan.dyClosest ? y > rect.bottom
      : (x > (rect.left + rect.right) / 2) == (dir == Direction.LTR)
    if (after) return new PosAssoc(start + findClusterBreak(this.text, closest), -1)
    else return new PosAssoc(pos, 1)
  }

  static of(text: string) {
    return new TextTile(text, document.createTextNode(text))
  }
}

function buildFromShape(shape: Shape, node: Node | null, nodeInner = false) {
  if (shape instanceof Elt) {
    let outer = EltTile.of(shape, node,
                           (nodeInner ? TileFlag.NodeInner : 0) | (nodeInner && !shape.hasContent ? TileFlag.Point : 0) |
                             (node && !shape.hasContent ? TileFlag.Atom : 0),
                           node ? node.length : 0)
    if (shape.children) for (let child of shape.children)
      outer.addChild(buildFromShape(typeof child == "string" ? TextWidget.of(child) : child, null, nodeInner || !!node))
    return outer
  } else {
    return new WidgetTile(shape, node, nodeInner ? TileFlag.Point | TileFlag.NodeInner : 0 as TileFlag, node ? node.length : 0)
  }
}

function copyEltShape(tile: EltTile, node: Node | null, elt = tile.elt): EltTile {
  // FIXME is blindly copying length and tags safe here?
  let outer = EltTile.of(elt, node, tile.flags, node ? node.length : tile.length, tile.dom)
  if (!elt.hasContent) {
    for (let ch of tile.children) outer.addChild(copyShape(ch as EltTile | WidgetTile))
  }
  return outer
}

function copyWidgetShape(tile: WidgetTile, node: Node | null): WidgetTile {
  return new WidgetTile(tile.widget, node, tile.flags, tile.length, tile.dom)
}

function copyShape(tile: EltTile | WidgetTile): EltTile | WidgetTile {
  return tile instanceof EltTile ? copyEltShape(tile, tile.node) : copyWidgetShape(tile, tile.node)
}

const noChildren: Tile[] = []

interface TileWalker {
  enter(tile: EltTile): void
  skip(tile: Tile, from: number, to: number): void
  leave(tile: EltTile): void
}

// Used to track the previous tree during an update.
class TilePointer {
  constructor(readonly tile: Tile, readonly index: number, readonly parent: TilePointer | null) {}

  walk(dist: number, side: -1 | 1, walker?: TileWalker) {
    let {tile, index, parent} = this, nodeBoundary = 0 // 1=entering, 2=leaving
    for (;;) {
      if (!dist && side < 0 && !nodeBoundary) break
      if (tile.isText) {
        if (!dist) break
        nodeBoundary = 0
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
        if (nodeBoundary == 1 && !next.isNodeInner) {
          nodeBoundary = 0
          if (side < 0 && !dist) break
        }
        if (!dist && next.isNodeInner && !nodeBoundary) break
        if (next.length <= dist) {
          if (walker) walker.skip(next, 0, next.length)
          dist -= next.length
          index++
          if (!next.isNodeInner) nodeBoundary = 0
        } else {
          if (next.isNodeOuter && (!dist || next.isAtom && !next.isText)) break
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
    if (tile.isText) return tile
    return index < tile.children.length ? tile.children[index] : null
  }

  matchingWrapper(elt: DecoElt, spanning: boolean, reused: Map<Tile, Reused>) {
    let best: EltTile | undefined, bestScore = 0
    let start = this.tile.isText ? this.parent! : this
    for (let {tile, parent} = start; !(tile.isNode || tile.isDoc); {tile, parent} = parent!) {
      let wrap = tile as EltTile
      if (reused.has(wrap) || wrap.elt.tagName != elt.tagName || wrap.isSpanning != spanning) continue
      let score = compareAttributes(wrap.elt.attrs, elt.attrs)
      if (!best || bestScore < score) {
        best = wrap
        bestScore = score
      }
    }
    if (!best) return null
    if (bestScore < 0) updateAttributes(best.dom, best.elt.attrs, elt.attrs)
    reused.set(best, Reused.DOM)
    return best.dom
  }

  matchingWidget(widget: Widget<any>, sideFlag: number, reused: Map<Tile, Reused>) {
    let {index, tile, parent} = this
    for (;;) {
      if (!index) {
        if (!parent || (tile instanceof EltTile ? tile.node : !(tile instanceof TextTile))) break
        ;({index, tile, parent} = parent)
      } else {
        if (tile instanceof TextTile) break
        let before = tile.children[--index]
        if (!before.isPoint) break
        if (!reused.has(before) && before instanceof WidgetTile && before.widget.eq(widget) &&
            (before.flags & TileFlag.PointSide) == sideFlag) {
          reused.set(before, Reused.Full)
          return before
        }
      }
    }
    return null
  }
}

const enum Reused { Full = 1, DOM = 2 }

class ContentUpdate {
  old: TilePointer
  new: CompositeTile
  // Current position in the new document
  posB = 0
  reused = new Map<Tile, Reused>()
  keepWalker: TileWalker

  constructor(readonly state: EditorState, old: DocTile, readonly deco: DecoIterator, cursorWrapper: readonly Mark<any>[] | null) {
    this.old = new TilePointer(old, 0, null)
    this.new = new DocTile(state, old.dom as HTMLElement, cursorWrapper)
    this.keepWalker = {
      enter: tile => {
        let span = tile.isSpanning && this.enterSpanning(tile.elt)
        if (span) {
          this.new = span
        } else {
          this.reused.set(tile, Reused.DOM)
          let inner = EltTile.of(tile.elt, tile.node, tile.flags, tile.boundary * 2, tile.dom)
          this.new.addChild(inner)
          this.new = inner
        }
      },
      leave: tile => {
        this.up()
      },
      skip: (tile, from, to) => {
        if (!(tile instanceof TextTile)) {
          this.reused.set(tile, Reused.Full)
          this.new.addChild(tile)
        } else if (this.new.lastChild instanceof TextTile && !this.new.lastChild.isComposition) {
          this.addText(tile.text.slice(from, to))
        } else if (!from && to == tile.text.length) {
          this.reused.set(tile, Reused.Full)
          this.new.addChild(tile)
        } else if (!this.reused.has(tile)) {
          this.reused.set(tile, Reused.DOM)
          this.new.addChild(new TextTile(tile.text.slice(from, to), tile.dom))
        } else {
          this.new.addChild(TextTile.of(tile.text.slice(from, to)))
        }
      }
    }
  }

  keep(len: number, includeStart: boolean, includeEnd: boolean) {
    if (!includeStart) {
      this.old = this.old.walk(0, 1)
      this.openOldWrappers()
    }
    this.old = this.old.walk(len, includeEnd ? 1 : -1, this.keepWalker)
    this.posB += len
  }

  replace(len: number, ins: number, includeStart: boolean) {
    let start = this.old.walk(0, 1), end = this.old = start.walk(len, 1)
    this.build(ins, false, includeStart, start, end)
  }

  update(len: number, includeStart: boolean) {
    this.old = this.old.walk(0, 1)
    this.build(len, true, includeStart)
  }

  composition(composition: CompositionInfo) {
    this.leaveWrappers()
    if (!composition.target) {
      for (let mark of composition.wrapCursor!) if (mark.type.element) {
        this.openWrapper(renderMarkWrapper(mark), mark.spanning, false)
      }
      this.new.addChild(new WidgetTile(imgHack, null, TileFlag.Point | TileFlag.PointBefore))
      return
    }
    let found: EltTile[] = []
    for (let parent = composition.target.parentNode; parent; parent = parent.parentNode) {
      let tile = parent.wgTile
      if (!tile) {
        let elt = new Elt<never>(parent.nodeName.toLowerCase(), takeAttributes(parent as HTMLElement), null)
        tile = new EltTile(elt, null, 0, 0, parent as HTMLElement)
      } else if (tile.isNode || tile.isDoc) {
        break
      }
      found.push(tile as EltTile)
    }
    for (let i = found.length - 1; i >= 0; i--) {
      let tile = found[i]
      if (tile.isSpanning && this.enterSpanning(tile.elt)) {
      } else {
        if (tile.isSpanning && this.reused.has(tile)) {
          let owner = tile.dom.wgTile
          if (owner && owner != tile) owner.dom = eltDOM((owner as EltTile).elt)
        } else {
          this.reused.set(tile, Reused.DOM)
        }
        tile = EltTile.of(tile.elt, null, tile.flags, 0, tile.dom)
        this.new.addChild(tile)
        this.new = tile
      }
    }
    this.new.addChild(new TextTile(composition.text, composition.target, TileFlag.Composition))
    this.old = this.old.walk(composition.toA - composition.fromA, 1)
    this.posB += composition.text.length
  }

  build(len: number, reuse: boolean, includeStart: boolean, startOld?: TilePointer, endOld?: TilePointer) {
    this.leaveWrappers()
    let start = this.posB, end = this.posB + len
    this.deco.walk(start, includeStart, end, {
      enter: (node, elt, wrappers) => {
        this.openWrappers(wrappers, node.tag, reuse)
        let tile: EltTile | undefined
        if (reuse) {
          let nodeTile = this.old.tileAfter()
          if (nodeTile instanceof EltTile && !this.reused.has(nodeTile) &&
              nodeTile.elt.tagName == elt.tagName && nodeTile.elt.eqChildren(elt)) {
            this.reused.set(nodeTile, Reused.DOM)
            updateAttributes(nodeTile.dom, nodeTile.elt.attrs, elt.attrs)
            tile = copyEltShape(nodeTile, node, elt)
          }
        }
        if (!tile) {
          tile = EltTile.of(elt, node, 0, 2)
          if (elt.children) for (let ch of elt.children)
            tile.addChild(buildFromShape(typeof ch == "string" ? TextWidget.of(ch) : ch, null, true))
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
        this.openWrappers(wrappers, node.tag, reuse)
        let tile: Tile | undefined
        if (reuse || node.isText && this.posB == start) {
          let nodeTile = this.old.tileAfter()
          if (nodeTile && !this.reused.has(nodeTile)) {
            if (shape instanceof Elt && nodeTile instanceof EltTile &&
                nodeTile.elt.tagName == shape.tagName && nodeTile.elt.eqChildren(shape)) {
              this.reused.set(nodeTile, Reused.DOM)
              updateAttributes(nodeTile.dom, nodeTile.elt.attrs, shape.attrs)
              tile = copyEltShape(nodeTile, node, shape)
            } else if (node.is(Leaf.Text) && nodeTile instanceof TextTile && !(this.new.lastChild instanceof TextTile) &&
                       (reuse || this.posB == start)) {
              if (nodeTile.text != node.param) {
                nodeTile.dom.nodeValue = node.param
                tile = new TextTile(node.param, nodeTile.dom)
                this.reused.set(nodeTile, Reused.DOM)
              } else {
                tile = nodeTile
                this.reused.set(nodeTile, Reused.Full)
              }
            } else if (shape instanceof Widget && nodeTile instanceof WidgetTile &&
                       nodeTile.widget.eq(shape)) {
              tile = copyWidgetShape(nodeTile, node)
            }
          }
        }
        if (!tile) {
          if (node.is(Leaf.Text)) this.addText(node.param)
          else tile = buildFromShape(shape, node)
        }
        if (tile) this.new.addChild(tile)
        for (let _ of wrappers) this.up()
        if (reuse) this.old = this.old.walk(node.length, 1)
        this.posB += node.length
      },
      widget: (widget, side) => {
        let sideFlag = side < 0 ? TileFlag.PointBefore : side > 0 ? TileFlag.PointAfter : 0
        let found = reuse ? this.old.matchingWidget(widget, sideFlag, this.reused)
          : startOld && this.posB == start ? startOld.matchingWidget(widget, sideFlag, this.reused)
          : endOld && this.posB == end ? endOld.matchingWidget(widget, sideFlag, this.reused)
          : null
        this.new.addChild(found || new WidgetTile(widget, null, TileFlag.Point | sideFlag, 0))
      }
    })
  }

  up() {
    let node = this.new.node
    if (node && node.isPlot && node.isTextblock) {
      let i = this.new.children.length - 1
      let last = i < 0 ? null : this.new.children[i]
      if (last instanceof WidgetTile && last.widget.type == brHack.type) {
        let prev = i ? this.new.children[i - 1] : null
        if (prev && prev.dom.nodeName != "BR")
          this.new.children.pop()
      } else if (!last || last.dom.nodeName == "BR") {
        this.new.addChild(new WidgetTile(brHack, null, TileFlag.Point | TileFlag.PointAfter, 0))
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

  leaveWrappers() {
    while (!(this.new.isNode || this.new.isDoc)) this.up()
  }

  openWrappers(wrappers: readonly WrapperSource[], tag: Node.Tag, reuse: boolean) {
    for (let src of wrappers) {
      this.openWrapper(renderWrapper(src, tag), src.spanning, reuse)
    }
  }

  openOldWrappers() {
    let found: EltTile[] | undefined
    let start = this.old.tile.isText ? this.old.parent! : this.old
    for (let {tile, parent} = start; !tile.isNode && !tile.isDoc; {tile, parent} = parent!) {
      ;(found || (found = [])).push(tile as EltTile)
    }
    if (found) for (let i = found.length - 1; i >= 0; i--) {
      this.openWrapper(found[i].elt, found[i].isSpanning, true)
    }
  }

  openWrapper(elt: DecoElt, spanning: boolean, reuse: boolean) {
    let span = spanning && this.enterSpanning(elt)
    if (span) {
      this.new = span
    } else {
      let match = reuse ? this.old.matchingWrapper(elt, spanning, this.reused) : null
      let tile = EltTile.of(elt, null, spanning ? TileFlag.Spanning : 0, 0, match)
      this.new.addChild(tile)
      this.new = tile
    }
  }

  enterSpanning(elt: DecoElt) {
    let cur = this.new
    for (let i = cur.children.length - 1; i >= 0; i--) {
      let prev = cur.children[i] as EltTile
      if (prev.isPoint) continue
      if (!prev.isSpanning || !prev.elt.eq(elt)) break
      // If this is a node from the old tree, copy it
      if (prev.flags & TileFlag.Synced) {
        let copy = cur.children[i] = EltTile.of(elt, null, prev.flags, 0, prev.dom)
        for (let ch of prev.children) copy.addChild(ch)
        prev = copy
        prev.parent = cur
      }
      // Move any point tiles after the wrapper into it
      for (let j = i + 1; j < cur.children.length; j++) prev.addChild(cur.children[j])
      return prev
    }
    return null
  }

  addText(text: string) {
    let last = this.new.lastChild
    if (!(last instanceof TextTile) || last.isComposition) {
      this.new.addChild(TextTile.of(text))
    } else if (last.flags & TileFlag.Synced) {
      this.new.children.pop()
      this.new.addChild(new TextTile(last.text + text, last.dom))
      this.reused.set(last, Reused.DOM)
    } else {
      last.text += text
      last.length += text.length
    }
  }

  finish() {
    while (!(this.new instanceof DocTile)) this.up()
    return this.new
  }
}

function takeAttributes(elt: HTMLElement): Attributes {
  let attrs: string[] = []
  for (let i = 0; i < elt.attributes.length; i++) {
    let {name, value} = elt.attributes[i]
    pushAttribute(attrs, name, value)
  }
  return attrs.length ? attrs : noAttributes
}

function updateAttributes(dom: HTMLElement, a: Attributes, b: Attributes) {
  for (let iA = 0, iB = 0;;) {
    if (iA < a.length && iB < b.length && a[iA] == b[iB]) {
      if (a[iA + 1] != b[iB + 1]) dom.setAttribute(b[iB], b[iB + 1])
      iA += 2; iB += 2
    } else if (iA < a.length && (iB == b.length || a[iA] < b[iB])) {
      dom.removeAttribute(a[iA])
      iA += 2
    } else if (iB < b.length) {
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

const imgHack = Widget.create({
  render() { return document.createElement("img") }
})

function separateComposition(sections: ChangeSet.Sections, comp: CompositionInfo) {
  let result: number[] = [], diff = 0
  let {fromA, toA} = comp, compIns = comp.text.length
  for (let posA = 0, done = false, i = 0; i < sections.length;) {
    let len = sections[i++], ins = sections[i++], endA = posA + len
    if (fromA > endA || toA < posA) {
      result.push(len, ins)
    } else {
      if (ins >= 0) {
        if (posA < fromA || endA > toA) return null
        diff += ins - len
      }
      if (posA < fromA) result.push(fromA - posA, ins)
      if (!done) {
        result.push(toA - fromA, compIns)
        done = true
      }
      if (endA > toA) result.push(endA - toA, ins)
    }
    posA = endA
  }
  if (diff != compIns - (toA - fromA)) return null
  return result
}
