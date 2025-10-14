import {Node as WGNode, Tag, ChangeDesc, compareAttributes, Elt, Attributes,
        pushAttribute, noAttributes} from "@wordgard/doc"
import {EditorState} from "@wordgard/state"
import {Widget, TextWidget, DecoElt, Shape, DecoIterator, findChangedRanges, WrapperSource,
        renderWrapper, renderPropWrapper} from "./decoration"
import {type CompositionInfo} from "./input"
import {type EditorView} from "./editorview"

const LOG_update = false

declare global {
  interface Node { wgTile?: Tile }
}

export const enum TileFlag {
  NodeInner = 1,
  Spanning = 2,
  Point = 4,
  PointBefore = 8,
  PointAfter = 16,
  PointSide = PointBefore | PointAfter,
  Composition = 32,
  Synced = 64,
  Atom = 128, // Composite node whose length isn't determined by child length
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

  // FIXME include side in output?
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
    let len = this.boundary * 2
    for (let ch of this.children) {
      ch.sync()
      len += ch.length
    }
    if (!(this.flags & TileFlag.Atom)) this.length = len
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

export class DocTile extends CompositeTile {
  declare dom: HTMLElement

  constructor(public state: EditorState, dom: HTMLElement) {
    super(dom, 0)
  }

  static create(state: EditorState, dom: HTMLElement) {
    return new DocTile(state, dom).updateRanges(state, [0, state.doc.length])
  }

  get isDoc() { return true }

  update(state: EditorState, changes: ChangeDesc, composition?: CompositionInfo | null) {
    return this.updateRanges(state, findChangedRanges(this.state, state, changes), composition)
  }

  updateRanges(state: EditorState, sections: readonly number[], composition?: CompositionInfo | null) {
    // FIXME somehow avoid redraws when composition didn't change from last call and no content changes
    if (sections.length == 2 && sections[1] == -1 && !composition) return this
    LOG_update && console.log(`updateRanges(${state.doc},`, sections, composition, ")")
    if (composition) {
      let separated = separateComposition(sections, composition)
      LOG_update && !separated && console.log("separateComposition failed")
      if (!separated) composition = null
      else sections = separated
    }
    let builder = new ContentUpdate(state, this, new DecoIterator(state))
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
    LOG_update && console.log("/updateRanges " + result + " : " + result.dom.innerHTML)
    return result
  }

  nearest(dom: Node, requireTag = true) {
    for (let cur: Node | null = dom; cur; cur = cur.parentNode) {
      let elt = cur.wgTile
      if (elt && (!requireTag || elt.isNode) && this.owns(elt)) return elt
    }
    return null
  }

  // FIXME this will follow stale parent pointers. Need to clear those somehow
  owns(elt: Tile) {
    for (;;) {
      let {parent} = elt
      if (parent == this) return true
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

  posFromDOM(dom: Node, offset: number, bias: -1 | 1 = -1) {
    let elt = this.nearest(dom)
    if (!elt)
      return this.dom.compareDocumentPosition(dom) & 4 /* following */ ? this.length : 0
    return elt.localPosFromDOM(dom, offset, bias)
  }

  posBeforeDOM(dom: Node) {
    let tile = this.nearest(dom)
    if (!tile) return null
    let pos = tile.posAtStart
    if (tile.dom != dom) for (let ch of tile.children) {
      if (ch.dom.compareDocumentPosition(dom) & 2 /* preceding */) break
      pos += ch.length
    }
    return pos
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

  constructor(readonly elt: DecoElt, readonly tag: Tag | null, flags: number, length: number, dom: HTMLElement) {
    super(dom, flags)
    this.length = length
  }

  get isSpanning() { return (this.flags & TileFlag.Spanning) > 0 }

  get isNodeOuter() { return !!this.tag }

  get isAtom() { return !!this.tag && (this.flags & TileFlag.Atom) > 0 }

  get boundary() { return this.tag && !(this.flags & TileFlag.Atom) ? 1 : 0 }

  get contentTile(): EltTile | null {
    for (let ch of this.children) if (ch.isNodeInner && (ch as EltTile).elt.hasContent) return (ch as EltTile).contentTile
    return this.elt.hasContent ? this : null
  }

  static of(elt: DecoElt, tag: Tag | null, flags: number, length: number, dom?: HTMLElement | null) {
    return new EltTile(elt, tag, flags, length, dom || eltDOM(elt))
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
    readonly node: WGNode | null,
    flags: TileFlag,
    length: number = 0,
    dom?: HTMLElement | Text
  ) {
    super(dom || widget.type.render(widget.value), flags)
    this.length = length
  }

  get isNodeOuter() { return !!this.node }

  get isAtom() { return true }

  get children() { return noChildren }

  handleEvent(event: Event, view: EditorView) { return this.widget.type.handleEvent(event, view) }

  toString() { return this.widget.type == TextWidget ? JSON.stringify(this.widget.value) : super.toString() }
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

  localPosFromDOM(dom: Node, offset: number): number {
    return this.posAtStart + Math.min(offset, this.length)
  }

  static of(text: string) {
    return new TextTile(text, document.createTextNode(text))
  }
}

function buildFromShape(shape: Shape, node: WGNode | null, nodeInner = false) {
  if (shape instanceof Elt) {
    let outer = EltTile.of(shape, node && node.tag,
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

function copyEltShape(tile: EltTile, tag: Tag | null): EltTile {
  let outer = EltTile.of(tile.elt, tag, tile.flags, tile.length, tile.dom)
  if (!tile.elt.hasContent) {
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

  matchingWrapper(elt: DecoElt, spanning: boolean, reused: Set<HTMLElement | Text>) {
    let best: EltTile | undefined, bestScore = 0
    let start = this.tile.isText ? this.parent! : this
    for (let {tile, parent} = start; !(tile.isNode || tile.isDoc); {tile, parent} = parent!) {
      let wrap = tile as EltTile
      if (reused.has(wrap.dom) || wrap.elt.tagName != elt.tagName || wrap.isSpanning != spanning) continue
      let score = compareAttributes(wrap.elt.attrs, elt.attrs)
      if (!best || bestScore < score) {
        best = wrap
        bestScore = score
      }
    }
    if (!best) return null
    if (bestScore < 0) updateAttributes(best.dom, best.elt.attrs, elt.attrs)
    reused.add(best.dom)
    return best.dom
  }

  matchingWidget(widget: Widget<any>, sideFlag: number, reused: Set<HTMLElement | Text>) {
    let {index, tile, parent} = this
    for (;;) {
      if (!index) {
        if (!parent || (tile instanceof EltTile ? tile.tag : !(tile instanceof TextTile))) break
        ;({index, tile, parent} = parent)
      } else {
        if (tile instanceof TextTile) break
        let before = tile.children[--index]
        if (!before.isPoint) break
        if (!reused.has(before.dom) && before instanceof WidgetTile && before.widget.eq(widget) &&
            (before.flags & TileFlag.PointSide) == sideFlag)
          return before
      }
    }
    return null
  }
}

class ContentUpdate {
  old: TilePointer
  new: CompositeTile
  // Current position in the new document
  posB = 0
  reused = new Set<HTMLElement | Text>()

  constructor(readonly state: EditorState, old: DocTile, readonly deco: DecoIterator) {
    this.old = new TilePointer(old, 0, null)
    this.new = new DocTile(state, old.dom as HTMLElement)
    // FIXME pre-allocate walkers?
  }

  keep(len: number, includeStart: boolean, includeEnd: boolean) {
    let walker: TileWalker = {
      enter: tile => {
        let span = tile.isSpanning && this.enterSpanning(tile.elt)
        if (span) {
          this.new = span
        } else {
          this.reused.add(tile.dom)
          let inner = EltTile.of(tile.elt, tile.tag, tile.flags, tile.boundary * 2, tile.dom)
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
        } else if (this.new.lastChild instanceof TextTile && !this.new.lastChild.isComposition) {
          this.addText(tile.text.slice(from, to))
        } else if (!from && to == tile.text.length) {
          this.new.addChild(tile)
        } else if (!this.reused.has(tile.dom)) {
          this.reused.add(tile.dom)
          this.new.addChild(new TextTile(tile.text.slice(from, to), tile.dom))
        } else {
          this.new.addChild(TextTile.of(tile.text.slice(from, to)))
        }
      }
    }
    if (!includeStart) {
      this.old = this.old.walk(0, 1)
      this.openOldWrappers()
    }
    this.old = this.old.walk(len, includeEnd ? 1 : -1, walker)
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
      for (let prop of composition.wrapCursor!) if (prop.type.element) {
        this.openWrapper(renderPropWrapper(prop), prop.spanning, false)
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
        if (tile.isSpanning && this.reused.has(tile.dom)) {
          let owner = tile.dom.wgTile
          if (owner && owner != tile) owner.dom = eltDOM((owner as EltTile).elt)
        } else {
          this.reused.add(tile.dom)
        }
        tile = EltTile.of(tile.elt, null, tile.flags, 0, tile.dom)
        this.new.addChild(tile)
        this.new = tile
      }
    }
    this.new.addChild(new TextTile(composition.text, composition.target, TileFlag.Composition))
    this.reused.add(composition.target)
    this.old = this.old.walk(composition.toA - composition.fromA, 1)
    this.posB += composition.text.length
  }

  build(len: number, reuse: boolean, includeStart: boolean, startOld?: TilePointer, endOld?: TilePointer) {
    this.leaveWrappers()
    let start = this.posB, end = this.posB + len
    this.deco.walk(start, includeStart, end, {
      enter: (tag, elt, wrappers) => {
        this.openWrappers(wrappers, tag, reuse)
        let tile: EltTile | undefined
        if (reuse) {
          let nodeTile = this.old.tileAfter()
          if (nodeTile instanceof EltTile && !this.reused.has(nodeTile.dom) &&
              nodeTile.elt.tagName == elt.tagName && nodeTile.elt.eqChildren(elt)) {
            this.reused.add(nodeTile.dom)
            updateAttributes(nodeTile.dom, nodeTile.elt.attrs, elt.attrs)
            tile = copyEltShape(nodeTile, tag)
          }
        }
        if (!tile) {
          tile = EltTile.of(elt, tag, 0, 2)
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
          if (nodeTile && !this.reused.has(nodeTile.dom)) {
            if (shape instanceof Elt && nodeTile instanceof EltTile &&
                nodeTile.elt.tagName == shape.tagName && nodeTile.elt.eqChildren(shape)) {
              this.reused.add(nodeTile.dom)
              updateAttributes(nodeTile.dom, nodeTile.elt.attrs, shape.attrs)
              tile = copyEltShape(nodeTile, node.tag)
            } else if (node.isText && nodeTile instanceof TextTile && !(this.new.lastChild instanceof TextTile) &&
                       (reuse || this.posB == start)) {
              this.reused.add(nodeTile.dom)
              if (nodeTile.text != node.text) {
                nodeTile.dom.nodeValue = node.text!
                tile = new TextTile(node.text!, nodeTile.dom)
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
          if (node.isText) this.addText(node.text!)
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
    if (this.new instanceof EltTile && this.new.tag && this.new.tag.isTextblock) {
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

  openWrappers(wrappers: readonly WrapperSource[], tag: Tag, reuse: boolean) {
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
      cur.children.length = i + 1
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
      this.new.addChild(this.reused.has(last.dom) ? TextTile.of(last.text + text) : new TextTile(last.text + text, last.dom))
      this.reused.add(last.dom)
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

const imgHack = Widget.create({
  render() { return document.createElement("img") }
})

function separateComposition(sections: readonly number[], comp: CompositionInfo) {
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
