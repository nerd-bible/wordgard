import {Node, Tag, Prop, ChangeDesc, ElementRepresentation, AttributeRepresentation} from "@wordgard/doc"
import {EditorState} from "@wordgard/state"
import {DOMNode} from "./dom"
import {eqArray} from "./shape"
import {DecoIterator, findChangedRanges} from "./decoration"
import {Elt, Widget} from "./shape"

export const enum ViewNodeFlag {
  NodeOuter = 1,
  NodeInner = 2,
  Node = 3,
  Atom = 4,
  Text = 8,
  Spanning = 16,
}

export class ContentPos {
  constructor(
    readonly node: ViewNode,
    readonly offset: number,
    readonly pos: number
  ) {}
}

export abstract class ViewNode {
  parent: DocViewNode | EltViewNode | null = null
  abstract children: ViewNode[]
  length = 2 * this.boundary

  constructor(readonly dom: DOMNode, readonly flags: number) {
    dom.wsElt = this
  }

  get isAtom() { return (this.flags & ViewNodeFlag.Atom) > 0 }
  get isSpanning() { return (this.flags & ViewNodeFlag.Spanning) > 0 }
  get isNodeOuter() { return (this.flags & ViewNodeFlag.NodeOuter) > 0 }
  get isNodeInner() { return (this.flags & ViewNodeFlag.NodeInner) > 0 }
  get isNode() { return (this.flags & ViewNodeFlag.Node) > 0 }
  get isText() { return (this.flags & ViewNodeFlag.Text) > 0 }

  sync() {}

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
  localPosFromDOM(dom: DOMNode, offset: number, bias: -1 | 1): number {
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

export class DocViewNode extends ViewNode {
  children: ViewNode[] = []

  constructor(public state: EditorState, dom: HTMLElement) {
    super(dom, 0)
  }

  static create(state: EditorState, dom: HTMLElement) {
    return new DocViewNode(state, dom).updateRanges(state, [0, state.doc.length])
  }

  update(state: EditorState, changes: ChangeDesc) {
    return this.updateRanges(state, findChangedRanges(this.state, state, changes))
  }

  // FIXME draw placeholder <br>s
  updateRanges(state: EditorState, sections: readonly number[]) {
    if (sections.length == 2 && sections[1] == -1) return this
    let builder = new ContentUpdate(state.doc, this, new DecoIterator(state))
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

  nearest(dom: DOMNode, requireTag = true) {
    for (let cur: DOMNode | null = dom; cur; cur = cur.parentNode) {
      let elt = cur.wsElt
      if (elt && (!requireTag || elt.tag) && this.owns(elt)) return elt
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
          if (before instanceof TextElt) return new ContentPos(before, before.length, pos)
          parent = before!; index = before!.children.length
        } else {
          if (after instanceof TextElt) return new ContentPos(after, 0, pos)
          parent = after; index = 0
        }
      } else {
        let next = parent.children[index]
        if (off + next.length > pos) {
          if (next instanceof TextElt) return new ContentPos(next, pos - off, pos)
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

  posFromDOM(dom: DOMNode, offset: number, bias: -1 | 1 = -1) {
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

function syncChildren(node: DocViewNode | EltViewNode) {
  let prev: DOMNode | null = null, next: DOMNode | null = node.dom.firstChild
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

export class EltViewNode extends ViewNode {
  declare dom: HTMLElement
  declare parent: EltViewNode | DocViewNode
  children: ViewNode[] = []

  constructor(readonly elt: Elt, flags: number) {
    let dom = document.createElement(elt.tagName)
    // FIXME add attrs
    super(dom, flags)
  }

  add(child: ViewNode) { // FIXME rename addChild
    this.children.push(child)
    this.length += child.length
    child.parent = this
  }

  get boundary() { return this.flags & ViewNodeFlag.NodeOuter && !(this.flags & ViewNodeFlag.Atom) ? 1 : 0 }
}

export class WidgetViewNode extends ViewNode {
  constructor(widget: Widget<any>, isNode: boolean, length: number = 0) {
    super(widget.type.render(widget.value), ViewNodeFlag.Atom | (isNode ? ViewNodeFlag.NodeOuter : 0))
    this.length = length
  }

  get children() { return noChildren }
}

export class TextViewNode extends ViewNode {
  constructor(public text: string) {
    super(document.createTextNode(text), ViewNodeFlag.Text)
    this.length = text.length
  }

  get children() { return noChildren }
}

const noChildren: ViewNode[] = []

function rm(dom: DOMNode): DOMNode | null {
  let next = dom.nextSibling
  dom.parentNode!.removeChild(dom)
  return next
}

interface ContentWalker {
  enter(elt: ViewNode): void
  skip(elt: ViewNode, parent: ViewNode | null): void
  leave(elt: ViewNode): void
}

class ContentPointer {
  constructor(readonly elt: ViewNode, public index: number, readonly parent: ContentPointer | null) {}

  copy(len: number, target: ViewNode) {
    
  }

  walk(dist: number, side: -1 | 1, walker?: ContentWalker) {
    let {elt, index, parent} = this, nodeBoundary = 0 // 1=entering, 2=leaving
    for (;;) {
      if (elt.isText) {
        if (!dist) break
        let left = elt.length - index
        if (dist >= left) {
          dist -= left
          if (left && walker)
            walker.skip(index ? new TextViewNode((elt as TextViewNode).text.slice(index)) : elt, elt.parent)
          ;({elt, index, parent} = parent!)
          index++
        } else {
          if (walker)
            walker.skip(new TextViewNode((elt as TextViewNode).text.slice(index, index + dist)), elt.parent)
          index += dist
          dist = 0
        }
      } else if (index == elt.children.length) {
        if (!dist && (nodeBoundary != 2 && elt.isNode || side < 0 && elt.isSpanning)) break
        if (walker) walker.leave(elt)
        nodeBoundary = elt.isNodeInner ? 2 : 0
        dist -= elt.boundary
        ;({elt, index, parent} = parent!)
        index++
      } else {
        let next = elt.children[index]
        if (next.length <= dist) {
          if (!next.length && // Non-node widget
              (next.isNodeInner ? nodeBoundary : side < 0))
            break
          if (walker) walker.skip(next, next.parent)
          dist -= next.length
          index++
          if (!next.isNodeInner) nodeBoundary = 0
        } else {
          if (next.isNode && (!dist || next.isAtom)) break
          if (!dist && next.isSpanning && side < 0) break
          if (walker && !next.isText) walker.enter(next)
          dist -= next.boundary
          parent = new ContentPointer(elt, index, parent)
          elt = next
          index = 0
          nodeBoundary = next.isNode ? 1 : 0
        }
      }
    }
    return new ContentPointer(elt, index, parent)
  }
}

function drawElement<T>(repr: ElementRepresentation<T>, value: T) {
  let elt = document.createElement(repr.element)
  if (repr.attributes) {
    let attrs = typeof repr.attributes == "function" ? repr.attributes(value) : repr.attributes
    for (let name in attrs) {
      let attr = attrs[name]
      if (attr != null) elt.setAttribute(name, String(attr))
    }
  }
  return elt
}

function drawDecoElement(deco: Decoration) {
  let elt = document.createElement(deco.element!)
  if (deco.attributes) for (let name in deco.attributes) {
    let value = deco.attributes[name]
    if (value != null) elt.setAttribute(name, String(value))
  }
  return elt
}

// Render a node, including its non-element attributes and decorations
function renderNode(tag: Tag, deco: readonly Decoration[]) {
  let text, elt
  if (tag.isText()) {
    text = document.createTextNode(tag.param as string)
  } else {
    let {dom} = tag.type.spec
    elt = typeof dom == "function" ? dom(tag.param) : drawElement(dom, tag.param)
  }
  for (let prop of tag.props) if (!prop.type.element) {
    let repr = prop.type.spec.dom as AttributeRepresentation<any>
    let value = repr.value == null ? String(prop.value) : typeof repr.value == "string" ? repr.value : repr.value(prop.value)
    if (value != null) {
      if (!elt) {
        elt = document.createElement(tag.isBlock() ? "div" : "span")
        elt.appendChild(text!)
      }
      addAttr(elt, repr.attribute, value)
    }
  }
  for (let d of deco) if (!d.element && d.attributes) {
    for (let attr in d.attributes) {
      let value = d.attributes[attr]
      if (value != null) {
        if (!elt) {
          elt = document.createElement(tag.isBlock() ? "div" : "span")
          elt.appendChild(text!)
        }
        addAttr(elt, attr, value)
      }
    }
  }
  return elt || text!
}

function addAttr(elt: HTMLElement, attr: string, value: string) {
  if (/^style\//.test(attr)) elt.style.setProperty(attr.slice(6), value)
  else if (attr == "class") elt.classList.add(value)
  else elt.setAttribute(attr, value)
}

const none: any[] = []

// FIXME define a shared interface to make interaction easier
type Wrapper = Prop | Decoration

function wrappers(props: readonly Prop[], deco: readonly Decoration[]): readonly Wrapper[] {
  let all = true, some = false
  for (let prop of props) {
    if (prop.type.element) some = true
    else all = false
  }
  let fromProps = all ? props : some ? props.filter(p => p.type.element) : none
  if (!deco.some(d => d.element)) return fromProps
  let eltDeco = deco.filter(d => d.element)
  return some ? (fromProps as readonly Wrapper[]).concat(eltDeco).sort((a, b) => a.rank - b.rank) : eltDeco
}

class ContentUpdate {
  old: ContentPointer
  new: ViewNode
  toSync: ViewNode[] = []
  pos = 0

  constructor(readonly state: EditorState, old: DocViewNode, readonly deco: DecoIterator) {
    this.old = new ContentPointer(old, 0, null)
    this.new = new DocViewNode(state, old.dom as HTMLElement)
    this.toSync.push(this.new)
  }

  keep(len: number) {
    this.pos += len
    this.old.copy(len, this.new)
  }


  open(tag: Tag, reuse: NodeElt | null, deco: readonly Decoration[]) {
    this.openWrappers(wrappers(tag.props, deco))
    let dom = reuse?.dom ?? renderNode(tag, deco)
    let elt = new NodeElt(tag, deco, dom, dom as HTMLElement)
    this.new.add(elt)
    this.toSync.push(elt)
    this.new = elt
  }

  close() {
    this.new = this.new.parent!
    this.closeWrappers()
  }

  joinText(tag: Tag<string>, deco: readonly Decoration[]) {
    let prev = this.new.lastChild
    while (prev && !(prev instanceof NodeElt)) prev = prev.lastChild
    if (!prev || !(prev instanceof TextElt) || !prev.tag.sameProps(tag) || !eqArray(prev.deco, deco)) return false
    prev.addText(tag.param)
    return true
  }

  leaf(node: Node, deco: readonly Decoration[]) {
    if (node.tag.isText() && this.joinText(node.tag, deco)) return
    this.openWrappers(wrappers(node.tag.props, deco))
    let dom = renderNode(node.tag, deco)
    let elt = node.isText() ? new TextElt(node.tag as Tag<string>, deco, dom) : new NodeElt(node.tag, deco, dom, null)
    this.new.add(elt)
    this.closeWrappers()
  }

  reuseNodes(elt: ViewNode, parent: ViewNode | null) {
    if (elt.tag) {
      if (elt.tag.isText() && this.joinText(elt.tag, (elt as NodeElt).deco)) {
        // Done
      } else {
        this.openWrappers(wrappers(elt.tag.props, (elt as NodeElt).deco), parent || elt.parent)
        this.new.add(elt)
        this.closeWrappers()
      }
    } else {
      for (let ch of elt.children) this.reuseNodes(ch, null)
    }
  }

  openWrappers(wrappers: readonly Wrapper[], reuse: ViewNode | null = null) {
    let prev = this.new.lastChild
    let canSpan = true
    for (let wrap of wrappers) {
      if (canSpan && (wrap instanceof Prop ? wrap.type.spanning : wrap.type == DecorationType.Spanning) &&
          prev && prev.isSpanning() && prev.eq(wrap)) {
        this.new = prev
        prev = this.new.lastChild
      } else {
        canSpan = false
        let dom
        if (reuse) for (let scan = reuse; scan instanceof WrapperElt; scan = scan.parent!) {
          if (scan.eq(wrap) && !this.toSync.some(e => e.dom == scan.dom)) {
            dom = scan.dom as HTMLElement
            break
          }
        }
        if (!dom)
          dom = wrap instanceof Prop ? drawElement(wrap.type.spec.dom as ElementRepresentation<any>, wrap.value)
            : drawDecoElement(wrap)
        let elt = new WrapperElt(wrap, dom)
        this.new.add(elt)
        this.toSync.push(elt)
        this.new = elt
      }
    }
  }

  closeWrappers() {
    while (this.new instanceof WrapperElt) this.new = this.new.parent!
  }

  replace(len: number, ins: number) {
    if (len) this.old = this.old.advance(len)
    this.deco.walk(this.pos, this.pos + ins, {
      enter: (tag, shape, wrappers) => {
        this.open(tag, null, deco)
      },
      leave: () => {
        this.close()
      },
      node: (node, shape, wrappers) => {
        this.leaf(node, deco)
      },
      widget: widget => {
        // FIXME draw widget
      }
    })
  }

  finish() {
    this.closeWrappers()
    for (let i = this.toSync.length - 1; i >= 0; i--) this.toSync[i].sync()
    return this.new as DocElt
  }
}

export class TextElt extends NodeElt {
  constructor(_tag: Tag<string>, deco: readonly Decoration[], dom: DOMNode) {
    super(_tag, deco, dom, null)
    this.length = _tag.param.length
  }
  
  get boundary() { return 0 }

  localPosFromDOM(dom: DOMNode, offset: number, bias: number) {
    return this.posAtStart + (dom.nodeType == 3 ? Math.min(offset, this.length) : offset ? this.length : 0)
  }

  toString() { return JSON.stringify(this.tag.param) }

  addText(text: string) {
    this._tag = this._tag.type.of(this.tag.param + text, this.tag.props) // FIXME
    this.length = this._tag.param.length
    let textNode = this.dom.nodeType == 3 ? this.dom : this.dom.firstChild!
    textNode.nodeValue = this._tag.param
  }
}
