import {DocNode, Node, Tag, Prop, Walker, ChangeDesc, Pos,
        ElementRepresentation, AttributeRepresentation} from "@willows/doc"
import {DOMNode} from "./dom"

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
    return this instanceof WrapperElt && this.prop.type.spanning && this.prop.type.element
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
              walker.skip(new TextElt(tag as Tag<string>, renderNode(tag)), elt.parent)
            } else {
              walker.skip(elt, elt.parent)
            }
          }
          ;({elt, index, parent} = parent!)
          index++
        } else {
          if (walker) {
            let tag = elt.tag.type.of(elt.tag.param.slice(index, index + dist), elt.tag.props)
            walker.skip(new TextElt(tag as Tag<string>, renderNode(tag)), elt.parent)
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

function renderNode(tag: Tag) { // FIXME deduplicate with DOM serializer?
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
        elt = document.createElement("span")
        elt.appendChild(text!)
      }
      if (/^style\//.test(repr.attribute)) elt.style.setProperty(repr.attribute.slice(6), value)
      else elt.setAttribute(repr.attribute, value)
    }
  }
  return elt || text!
}

const none: any[] = []

function wrappers(props: readonly Prop[]) {
  let all = true, some = false
  for (let prop of props) {
    if (prop.type.element) some = true
    else all = false
  }
  return all ? props : some ? props.filter(p => p.type.element) : none
}

class ContentUpdate {
  old: ContentPointer
  new: ContentElt
  cursor: Pos
  toSync: ContentElt[] = []

  constructor(readonly doc: DocNode, old: DocElt) {
    this.old = new ContentPointer(old, 0, null)
    this.new = new DocElt(doc, old.dom as HTMLElement)
    this.toSync.push(this.new)
    this.cursor = doc.resolveX(0)
  }

  open(tag: Tag, reuse?: NodeElt) {
    this.openWrappers(wrappers(tag.props))
    let dom = reuse?.dom ?? renderNode(tag)
    let elt = new NodeElt(tag, dom, dom as HTMLElement)
    this.new.add(elt)
    this.toSync.push(elt)
    this.new = elt
  }

  close() {
    this.new = this.new.parent!
    this.closeWrappers()
  }

  joinText(tag: Tag<string>) {
    let prev = this.new.lastChild
    while (prev && !(prev instanceof NodeElt)) prev = prev.lastChild
    if (!prev || !(prev instanceof TextElt) || !prev.tag.sameProps(tag)) return false
    prev.addText(tag.param)
    return true
  }

  leaf(node: Node) {
    if (node.tag.isText() && this.joinText(node.tag)) return
    this.openWrappers(wrappers(node.tag.props))
    let dom = renderNode(node.tag)
    let elt = node.isText() ? new TextElt(node.tag as Tag<string>, dom) : new NodeElt(node.tag, dom, null)
    this.new.add(elt)
    this.closeWrappers()
  }

  reuseNodes(elt: ContentElt, parent: ContentElt | null) {
    if (elt.tag) {
      if (elt.tag.isText() && this.joinText(elt.tag)) {
        // Done
      } else {
        this.openWrappers(wrappers(elt.tag.props), parent || elt.parent)
        this.new.add(elt)
        this.closeWrappers()
      }
    } else {
      for (let ch of elt.children) this.reuseNodes(ch, null)
    }
  }

  openWrappers(props: readonly Prop[], reuse: ContentElt | null = null) {
    let prev = this.new.lastChild
    let canSpan = true
    for (let prop of props) {
      if (canSpan && prop.type.spanning && prev?.prop && prev.prop.eq(prop)) {
        this.new = prev
        prev = this.new.lastChild
      } else {
        canSpan = false
        let dom
        if (reuse) for (let scan = reuse; scan instanceof WrapperElt; scan = scan.parent!) {
          if (scan.prop.eq(prop) && !this.toSync.some(e => e.dom == scan.dom)) {
            dom = scan.dom as HTMLElement
            break
          }
        }
        if (!dom) dom = drawElement(prop.type.spec.dom as ElementRepresentation<any>, prop.value)
        let elt = new WrapperElt(prop, dom)
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
    let walk: ContentWalker = { // FIXME store obj in builder
      enter: elt => {
        if (elt.tag) this.open(elt.tag, elt as NodeElt)
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
    let walk: Walker = {
      enter: tag => {
        this.open(tag)
      },
      leave: () => {
        this.close()
      },
      skip: node => {
        if (node.isLeaf()) {
          this.leaf(node)
        } else {
          this.open(node.tag)
          for (let ch of node.children) walk.skip(ch)
          this.close()
        }
      }
    }
    if (ins) this.cursor.advance(ins, walk)
  }

  finish() {
    this.closeWrappers()
    for (let i = this.toSync.length - 1; i >= 0; i--) this.toSync[i].sync()
    return this.new as DocElt
  }
}

export class DocElt extends ContentElt {
  constructor(readonly doc: DocNode, dom: HTMLElement) {
    super(dom, dom)
  }

  static create(doc: DocNode, dom: HTMLElement) {
    let empty = new DocElt(doc.schema.doc([]), dom)
    return empty.update(doc, new ChangeDesc([0, doc.length]))
  }

  update(doc: DocNode, changes: ChangeDesc) {
    if (changes.empty) return this
    let builder = new ContentUpdate(doc, this)
    for (let i = 0; i < changes.sections.length;) { // FIXME make this a method on changeSet?
      let len = changes.sections[i++], ins = changes.sections[i++]
      if (ins == -1) {
        builder.keep(len)
      } else {
        if (ins < 0) ins = len
        while (i < changes.sections.length && changes.sections[i + 1] != -1) {
          let len2 = changes.sections[i++], ins2 = changes.sections[i++]
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

  resolve(pos: number, assoc: -1 | 1) {
    let parent: ContentElt = this, index = 0, off = 0
    for (;;) {
      if (parent.tag?.isText()) return new ContentPos(parent, pos - off, pos)
      if (off == pos) {
        let before = index ? parent.children[index - 1] : null
        let after = index < parent.children.length ? parent.children[index] : null
        if (before?.boundary) before = null
        if (after?.boundary) after = null
        if (!before && !after) return new ContentPos(parent, index, pos)
        if (!after || before && assoc < 0) { parent = before!; index = before!.children.length }
        else { parent = after; index = 0 }
      } else {
        let next = parent.children[index]
        if (off + next.length > pos) {
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
    if (!elt) throw new RangeError("Trying to find position for a DOM position outside of the document")
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
  constructor(public _tag: Tag<any>, dom: DOMNode, contentDOM: HTMLElement | null) {
    super(dom, contentDOM)
  }

  get boundary() { return 1 }

  get tag(): Tag<unknown> { return this._tag }
}

export class TextElt extends NodeElt {
  constructor(_tag: Tag<string>, dom: DOMNode) {
    super(_tag, dom, null)
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

// FIXME actually create these
export class WrapperElt extends ContentElt {
  constructor(readonly _prop: Prop, dom: HTMLElement) {
    super(dom, dom)
  }

  get prop() { return this._prop }
}
