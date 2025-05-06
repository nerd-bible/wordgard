import {Node as WGNode, Tag, ChangeDesc} from "@wordgard/doc"
import {EditorState} from "@wordgard/state"
import {Shape} from "./shape"
import {DecoIterator, findChangedRanges} from "./decoration"
import {Elt, Widget} from "./shape"

declare global {
  interface Node { wsElt?: ViewNode }
}

// FIXME does having these still make sense?
export const enum ViewNodeFlag {
  NodeInner = 1,
}

export class ContentPos {
  constructor(
    readonly node: ViewNode,
    readonly offset: number,
    readonly pos: number
  ) {}

  get dom() { return this.node.dom }
}

export abstract class ViewNode {
  parent: CompositeViewNode | null = null
  abstract children: ViewNode[]
  length = 0

  constructor(readonly dom: Node, readonly flags: number) {
    dom.wsElt = this
  }

  get isAtom() { return false }
  get isNodeOuter() { return false }
  get isNodeInner() { return (this.flags & ViewNodeFlag.NodeInner) > 0 }
  get isNode() { return this.isNodeOuter || (this.flags & ViewNodeFlag.NodeInner) > 0 }
  get isText() { return false }
  get isDoc() { return false }
  get isSpanning() { return false }

  posBeforeChild(child: ViewNode): number {
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

  get firstChild(): ViewNode | null {
    return this.children.length ? this.children[0] : null
  }

  get lastChild(): ViewNode | null {
    let last = this.children.length - 1
    return last < 0 ? null : this.children[last]
  }

  // FIXME review for new approach
  localPosFromDOM(dom: Node, offset: number, bias: -1 | 1): number {
    // If the DOM position is in the content, use the child desc after
    // it to figure out a position.
    if (this.dom.contains(dom)) {
      let domBefore, elt: ViewNode | undefined
      if (dom == this.dom) {
        domBefore = dom.childNodes[offset - 1]
      } else {
        while (dom.parentNode != this.dom) dom = dom.parentNode!
        domBefore = dom.previousSibling
      }
      while (domBefore && !((elt = domBefore.wsElt) && elt.parent == this as ViewNode))
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

export class CompositeViewNode extends ViewNode {
  children: ViewNode[] = []

  addChild(child: ViewNode) {
    this.children.push(child)
    child.parent = this
    this.length += child.length
  }

  addText(text: string) {
    if (this.lastChild instanceof TextViewNode) this.lastChild.addText(text)
    else this.addChild(TextViewNode.of(text))
  }
}

export class DocViewNode extends CompositeViewNode {
  declare dom: HTMLElement

  constructor(public state: EditorState, dom: HTMLElement) {
    super(dom, 0)
  }

  static create(state: EditorState, dom: HTMLElement) {
    return new DocViewNode(state, dom).updateRanges(state, [0, state.doc.length])
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
        builder.keep(len)
      } else {
        // FIXME handle in-place updates differently to reuse elements
        builder.replace(len, ins < 0 ? len : ins)
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

  owns(elt: ViewNode) {
    for (;;) {
      let {parent} = elt
      if (parent == this) return true
      if (!parent) return false
      elt = parent
    }
  }

  // FIXME document or change weird assoc descent behavior
  resolve(pos: number, assoc: -1 | 0 | 1) {
    let parent: ViewNode = this, index = 0, off = 0
    for (;;) {
      if (off == pos) {
        let before = index ? parent.children[index - 1] : null
        let after = index < parent.children.length ? parent.children[index] : null
        if (before?.boundary) before = null
        if (after?.boundary) after = null
        if (assoc == 0 || !before && !after) return new ContentPos(parent, index, pos)
        if (!after || before && assoc < 0) {
          if (before instanceof TextViewNode) return new ContentPos(before, before.length, pos)
          parent = before!; index = before!.children.length
        } else {
          if (after instanceof TextViewNode) return new ContentPos(after, 0, pos)
          parent = after; index = 0
        }
      } else {
        let next = parent.children[index]
        if (off + next.length > pos) {
          if (next instanceof TextViewNode) return new ContentPos(next, pos - off, pos)
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

function syncChildren(node: CompositeViewNode) {
  let prev: Node | null = null, next: Node | null = node.dom.firstChild
  for (let child of node.children) {
    if (child.dom.parentNode == node.dom) {
      while (next && next != child.dom) next = rm(next)
    } else {
      node.dom.insertBefore(child.dom, next)
    }
    prev = child.dom
    next = prev.nextSibling
  }
  while (next) next = rm(next)
}

export class EltViewNode extends CompositeViewNode {
  declare dom: HTMLElement
  declare parent: CompositeViewNode

  constructor(readonly elt: Elt, readonly tag: Tag | null, flags: number, dom: HTMLElement) {
    super(dom, flags)
    // FIXME get correct length for non-leaf atoms
    this.length = tag && tag.isAtom() ? 1 : 2 * this.boundary
  }

  get isSpanning() { return this.elt.spanning }

  get isNodeOuter() { return !!this.tag }

  get isAtom() { return !!this.tag && this.tag.isAtom() }

  get boundary() { return this.tag && !this.tag.isAtom() ? 1 : 0 }

  get contentNode(): EltViewNode | null {
    for (let ch of this.children) if (ch.isNodeInner && (ch as EltViewNode).elt.hasHole) return (ch as EltViewNode).contentNode
    return this.elt.hasHole ? this : null
  }

  static of(elt: Elt, tag: Tag | null, flags: number) {
    let dom = document.createElement(elt.tagName)
    for (let i = 0; i < elt.attrs.length;) dom.setAttribute(elt.attrs[i++], elt.attrs[i++])
    return new EltViewNode(elt, tag, flags, dom)
  }
}

export class WidgetViewNode extends ViewNode {
  constructor(widget: Widget<any>, readonly node: WGNode | null, length: number = 0) {
    super(widget.type.render(widget.value), 0)
    this.length = length
  }

  get isNodeOuter() { return !!this.node }

  get isAtom() { return true }

  get children() { return noChildren }
}

export class TextViewNode extends ViewNode {
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
    return new TextViewNode(text, document.createTextNode(text))
  }
}

function buildFromShape(shape: Shape, node: WGNode | null, nodeInner = false) {
  if (shape instanceof Elt) {
    let outer = EltViewNode.of(shape, node && node.tag, nodeInner ? ViewNodeFlag.NodeInner : 0)
    for (let child of shape.children) outer.addChild(buildFromShape(child, null, nodeInner || !!node))
    return outer
  } else {
    return new WidgetViewNode(shape, node, node ? node.length : 0)
  }
}

const noChildren: ViewNode[] = []

function rm(dom: Node): Node | null {
  let next = dom.nextSibling
  dom.parentNode!.removeChild(dom)
  return next
}

interface ContentWalker {
  enter(node: EltViewNode): void
  skip(node: ViewNode, parent: ViewNode | null): void
  leave(node: EltViewNode): void
}

// Used to track the previous tree during an update. Stays inside of
// spanning nodes. (FIXME what does that mean, precisely?)
class ViewTreePointer {
  constructor(readonly node: ViewNode, public index: number, readonly parent: ViewTreePointer | null) {}

  walk(dist: number, side: -1 | 1, walker?: ContentWalker) {
    let {node, index, parent} = this, nodeBoundary = 0 // 1=entering, 2=leaving
    for (;;) {
      if (node.isText) {
        if (!dist) break
        let left = node.length - index
        if (dist >= left) {
          dist -= left
          if (left && walker)
            walker.skip(index ? TextViewNode.of((node as TextViewNode).text.slice(index)) : node, node.parent)
          ;({node, index, parent} = parent!)
          index++
        } else {
          if (walker)
            walker.skip(TextViewNode.of((node as TextViewNode).text.slice(index, index + dist)), node.parent)
          index += dist
          dist = 0
        }
      } else if (index == node.children.length) {
        if (!dist && (node.isDoc || nodeBoundary != 2 && node.isNode || side < 0 && node.isSpanning)) break
        if (walker) walker.leave(node as EltViewNode)
        nodeBoundary = node.isNodeInner ? 2 : 0
        dist -= node.boundary
        ;({node, index, parent} = parent!)
        index++
      } else {
        let next = node.children[index]
        if (next.length <= dist) {
          if (!next.length && // Non-node widget
              (next.isNodeInner ? nodeBoundary : side < 0))
            break
          if (walker) walker.skip(next, next.parent)
          dist -= next.length
          index++
          if (!next.isNodeInner) nodeBoundary = 0
        } else {
          if (next.isNode && !next.isText && (!dist || next.isAtom)) break
          if (!dist && next.isSpanning && side < 0) break
          if (walker && !next.isText) walker.enter(next as EltViewNode)
          dist -= next.boundary
          parent = new ViewTreePointer(node, index, parent)
          node = next
          index = 0
          nodeBoundary = next.isNode ? 1 : 0
        }
      }
    }
    return new ViewTreePointer(node, index, parent)
  }
}

class ContentUpdate {
  old: ViewTreePointer
  new: CompositeViewNode
  pos = 0

  constructor(readonly state: EditorState, old: DocViewNode, readonly deco: DecoIterator) {
    this.old = new ViewTreePointer(old, 0, null)
    this.new = new DocViewNode(state, old.dom as HTMLElement)
  }

  keep(len: number) {
    this.pos += len
    let cur = this.new
    this.old = this.old.walk(len, -1, {
      enter(node) {
        if (node.isSpanning && cur.lastChild?.isSpanning && node.elt.eq((cur.lastChild as EltViewNode).elt)) {
          cur = cur.lastChild as EltViewNode
        } else {
          let inner = new EltViewNode(node.elt, node.tag, node.flags, node.dom)
          cur.addChild(inner)
          cur = inner
        }
      },
      leave(n) {
        if (cur instanceof EltViewNode) syncChildren(cur)
        cur = cur.parent!
      },
      skip(node) {
        if (node instanceof TextViewNode) cur.addText(node.text)
        else cur.addChild(node)
      }
    })
    this.new = cur
  }

  replace(len: number, ins: number) {
    if (len) this.old = this.old.walk(len, -1)
    this.deco.walk(this.pos, this.pos + ins, {
      enter: (tag, elt, wrappers) => {
        for (let wrap of wrappers) this.openWrapper(wrap)
        let node = EltViewNode.of(elt, tag, 0)
        for (let ch of elt.children) node.addChild(buildFromShape(ch, null))
        this.new.addChild(node)
        this.new = node.contentNode!
        if (!this.new) throw new Error("Non-atom node rendered without hole")
      },
      leave: () => {
        this.leaveNode()
      },
      node: (node, shape, wrappers) => {
        for (let wrap of wrappers) this.openWrapper(wrap)
        if (node.isText()) this.new.addText(node.text!)
        else this.new.addChild(buildFromShape(shape, node))
        for (let _ of wrappers) this.up()
      },
      widget: widget => {
        this.new.addChild(buildFromShape(widget, null))
      }
    })
    this.pos += ins
  }

  up() {
    // FIXME this will run multiple time for spanning nodes
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

  openWrapper(elt: Elt) {
    if (elt.spanning && this.new.lastChild?.isSpanning && elt.eq((this.new.lastChild as EltViewNode).elt)) {
      this.new = this.new.lastChild as EltViewNode
    } else {
      let inner = EltViewNode.of(elt, null, 0)
      this.new.addChild(inner)
      this.new = inner
    }
  }

  finish() {
    while (!(this.new instanceof DocViewNode)) this.up()
    syncChildren(this.new)
    return this.new as DocViewNode
  }
}
