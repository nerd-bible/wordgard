import {DocNode, Node, Tag, Prop, ChangeDesc, Pos, ElementRepresentation, AttributeRepresentation} from "@wordgard/doc"
import {SpanSet} from "@wordgard/state"
import {DOMNode} from "./dom"
import {DecorationSet, Decoration, DecorationType, iterateDeco} from "./decoration"

declare global {
  interface Node { wsElt?: ContentElt }
}

export class ContentPos {
  constructor(
    readonly elt: ContentElt,
    readonly offset: number,
    readonly pos: number
  ) {}

  get node(): DOMNode { return this.elt.contentDOM || this.elt.dom }
}

export abstract class ContentElt {
  parent: ContentElt | null = null
  readonly children: ContentElt[] = []
  public length = 2 * this.boundary

  constructor(
    readonly dom: DOMNode,
    readonly contentDOM: HTMLElement | null
  ) {
    dom.wsElt = this
  }

  sync() {
    if (this.contentDOM) {
      let len = this.boundary * 2
      let prev: DOMNode | null = null, next: DOMNode | null = this.contentDOM.firstChild
      for (let child of this.children) {
        len += child.length
        if (child.dom.parentNode == this.contentDOM) {
          while (next && next != child.dom) next = rm(next)
        } else {
          this.contentDOM.insertBefore(child.dom, next)
        }
        prev = child.dom
        next = prev.nextSibling
      }
      while (next) next = rm(next)
      this.length = len
    }
  }

  add(child: ContentElt) {
    this.children.push(child)
    child.parent = this
  }

  isSpanning(): this is WrapperElt {
    return this instanceof WrapperElt &&
      !!(this.wrapper instanceof Prop ? this.wrapper.type.spanning && this.wrapper.type.element
          : this.wrapper.type == DecorationType.Spanning && this.wrapper.element)
  }

  posBeforeChild(child: ContentElt): number {
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

  localPosFromDOM(dom: DOMNode, offset: number, bias: -1 | 1): number {
    // If the DOM position is in the content, use the child desc after
    // it to figure out a position.
    if (this.contentDOM && this.contentDOM.contains(dom.nodeType == 1 ? dom : dom.parentNode)) {
      let domBefore, elt: ContentElt | undefined
      if (dom == this.contentDOM) {
        domBefore = dom.childNodes[offset - 1]
      } else {
        while (dom.parentNode != this.contentDOM) dom = dom.parentNode!
        domBefore = dom.previousSibling
      }
      while (domBefore && !((elt = domBefore.wsElt) && elt.parent == this)) domBefore = domBefore.previousSibling
      return domBefore ? this.posBeforeChild(elt!) + elt!.length : this.posAtStart
    }
    // Otherwise, use various heuristics, falling back on the bias
    // parameter, to determine whether to return the position at the
    // start or at the end of this content element.
    if (this.contentDOM && this.contentDOM != this.dom) {
      let cmp = dom.compareDocumentPosition(this.contentDOM)
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

  get lastChild(): ContentElt | null {
    let last = this.children.length - 1
    return last < 0 ? null : this.children[last]
  }

  get boundary() { return 0 }
  get tag(): Tag | null { return null }
  get prop(): Prop | null { return null }

  ignoreEvent(event: Event) { return false } // FIXME implement or redesign

  get ignoreMutations() { return false }

  toString() { return this.dom.nodeName + (this.children.length ? `(${this.children})` : "") }
}

function rm(dom: DOMNode): DOMNode | null {
  let next = dom.nextSibling
  dom.parentNode!.removeChild(dom)
  return next
}

interface ContentWalker {
  enter(elt: ContentElt): void
  skip(elt: ContentElt, parent: ContentElt | null): void
  leave(elt: ContentElt): void
}

class ContentPointer {
  constructor(readonly elt: ContentElt, public index: number, readonly parent: ContentPointer | null) {}

  advance(dist: number, walker?: ContentWalker) {
    let {elt, index, parent} = this
    while (dist > 0) {
      if (elt.tag?.isText()) {
        let left = elt.length - index
        if (dist >= left) {
          dist -= left
          if (left && walker) {
            if (index) {
              // FIXME make this easier
              let tag = elt.tag.type.of(elt.tag.param.slice(index), elt.tag.props)
              let {deco} = elt as NodeElt
              walker.skip(new TextElt(tag as Tag<string>, deco, renderNode(tag, deco)), elt.parent)
            } else {
              walker.skip(elt, elt.parent)
            }
          }
          ;({elt, index, parent} = parent!)
          index++
        } else {
          if (walker) {
            let tag = elt.tag.type.of(elt.tag.param.slice(index, index + dist), elt.tag.props)
            let {deco} = elt as NodeElt
            walker.skip(new TextElt(tag as Tag<string>, deco, renderNode(tag, deco)), elt.parent)
          }
          index += dist
          dist = 0
        }
      } else if (index == elt.children.length) {
        if (walker) walker.leave(elt)
        dist -= elt.boundary
        ;({elt, index, parent} = parent!)
        index++
      } else {
        let next = elt.children[index]
        if (next.length <= dist) {
          if (walker) walker.skip(next, next.parent)
          dist -= next.length
          index++
        } else {
          if (walker && !next.tag?.isText()) walker.enter(next)
          dist -= next.boundary
          parent = new ContentPointer(elt, index, parent)
          elt = next
          index = 0
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
  new: ContentElt
  cursor: Pos
  toSync: ContentElt[] = []

  constructor(readonly doc: DocNode, readonly deco: readonly DecorationSet[], old: DocElt) {
    this.old = new ContentPointer(old, 0, null)
    this.new = new DocElt(doc, old.dom as HTMLElement, deco)
    this.toSync.push(this.new)
    this.cursor = doc.resolve(0)
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

  reuseNodes(elt: ContentElt, parent: ContentElt | null) {
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

  openWrappers(wrappers: readonly Wrapper[], reuse: ContentElt | null = null) {
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

  keep(len: number) {
    this.cursor = this.cursor.advance(len)
    let walk: ContentWalker = { // FIXME store obj in builder, also for .replace
      enter: elt => {
        if (elt.tag) this.open(elt.tag, elt as NodeElt, []) // FIXME make sure deco is preserved somehow
      },
      leave: elt => {
        if (elt.tag) this.close()
      },
      skip: (elt, parent) => {
        this.reuseNodes(elt, parent)
      }
    }
    this.old = this.old.advance(len, walk)
  }

  replace(len: number, ins: number) {
    if (len) this.old = this.old.advance(len)
    this.cursor = iterateDeco(this.cursor, this.deco, this.cursor.pos, this.cursor.pos + ins, {
      enter: (tag, deco) => {
        this.open(tag, null, deco)
      },
      leave: () => {
        this.close()
      },
      skip: (node, deco) => {
        this.leaf(node, deco)
      },
      widget(widget, deco) {
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

export class DocElt extends ContentElt {
  constructor(readonly doc: DocNode, dom: HTMLElement, readonly deco: readonly DecorationSet[]) {
    super(dom, dom)
  }

  static create(doc: DocNode, deco: readonly DecorationSet[], dom: HTMLElement) {
    let empty = new DocElt(doc.schema.doc([]), dom, [])
    return empty.update(doc, deco, new ChangeDesc([0, doc.length]))
  }

  // FIXME draw placeholder <br>s
  update(doc: DocNode, deco: readonly DecorationSet[], changes: ChangeDesc) {
    let redraw = redrawableRanges(this.deco, deco, changes)
    if (redraw.empty) return this
    let builder = new ContentUpdate(doc, deco, this)
    for (let i = 0; i < redraw.sections.length;) { // FIXME make this a method on changedesc?
      let len = redraw.sections[i++], ins = redraw.sections[i++]
      if (ins == -1) {
        builder.keep(len)
      } else {
        if (ins < 0) ins = len
        while (i < redraw.sections.length && redraw.sections[i + 1] != -1) {
          let len2 = redraw.sections[i++], ins2 = redraw.sections[i++]
          len += len2; ins += ins2 < 0 ? len2 : ins2
        }
        builder.replace(len, ins)
      }
    }
    return builder.finish()
  }

  nearestNodeElt(dom: DOMNode) {
    for (let cur: DOMNode | null = dom; cur; cur = cur.parentNode) {
      let elt = cur.wsElt
      if (elt instanceof NodeElt && this.owns(elt)) return elt
    }
    return null
  }

  nearest(dom: DOMNode) {
    for (let cur: DOMNode | null = dom; cur; cur = cur.parentNode) {
      let elt = cur.wsElt
      if (elt && this.owns(elt)) return elt
    }
    return null
  }

  owns(elt: ContentElt) {
    for (;;) {
      let {parent} = elt
      if (parent == this) return true
      if (!parent) return false
      elt = parent
    }
  }

  // FIXME document or change weird assoc descent behavior
  resolve(pos: number, assoc: -1 | 0 | 1) {
    let parent: ContentElt = this, index = 0, off = 0
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
            throw new Error(`Invalid position ${pos} in document of size ${this.doc.length}`)
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

export class NodeElt extends ContentElt {
  constructor(public _tag: Tag<any>, public deco: readonly Decoration[], dom: DOMNode, contentDOM: HTMLElement | null) {
    super(dom, contentDOM)
  }

  get boundary() { return 1 }

  get tag(): Tag<unknown> { return this._tag }
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

export class WrapperElt extends ContentElt {
  constructor(readonly wrapper: Wrapper, dom: HTMLElement) {
    super(dom, dom)
  }

  eq(other: Wrapper) {
    return this.wrapper.constructor == other.constructor && this.wrapper.eq(other as any)
  }
}

// FIXME grow ranges that touch replaced nodes to cover them
function redrawableRanges(old: readonly DecorationSet[], deco: readonly DecorationSet[], changes: ChangeDesc) {
  let diff: {from: number, to: number}[] = [], last: {from: number, to: number} | null = null
  function add(from: number, to: number) {
    if (last && last.to == from) last.to = to
    else diff.push(last = {from, to})
  }
  SpanSet.compare(old, deco, changes, {
    comparePoint: add,
    compareSpan: add
  })
  return diff.length ? changes.composeDesc(ChangeDesc.createDesc(changes.newLength, diff)) : changes
}

function eqArray<T extends {eq(b: T): boolean}>(a: readonly T[], b: readonly T[]) {
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (!a[i].eq(b[i])) return false
  return true
}
