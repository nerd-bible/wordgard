import {DocNode, Tag, Prop, Context, Walker, ChangeSet, Slice, ElementRepresentation} from "@willows/doc"
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

  constructor(
    readonly children: readonly ContentElt[],
    readonly length: number,
    readonly dom: DOMNode,
    readonly contentDOM: HTMLElement | null
  ) {
    dom.wsElt = this
    if (contentDOM) {
      let prev: DOMNode | null = null, next: Node | null = contentDOM.firstChild
      for (let child of children) {
        child.parent = this
        if (child.dom.parentNode == contentDOM) {
          while (next && next != child.dom) next = rm(next)
        } else {
          contentDOM.insertBefore(child.dom, next)
        }
        prev = child.dom
        next = prev.nextSibling
      }
      while (next) next = rm(next)
    } else if (children.length) {
      throw new Error("FIXME")
    }
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

  get boundary() { return 0 }
  get tag(): Tag | null { return null }
  get prop(): Prop | null { return null }

  ignoreEvent(event: Event) { return false } // FIXME implement or redesign
}

function rm(dom: DOMNode): DOMNode | null {
  let next = dom.nextSibling
  dom.parentNode!.removeChild(dom)
  return next
}

interface ContentWalker {
  enter(elt: ContentElt): void
  skip(elt: ContentElt): void
  leave(elt: ContentElt): void
}

class ContentPointer {
  constructor(readonly elt: ContentElt, public index: number, readonly parent: ContentPointer | null) {}

  advance(dist: number, walker?: ContentWalker) {
    let {elt, index, parent} = this
    while (dist > 0) {
      if (index == elt.children.length) {
        if (walker) walker.leave(elt)
        dist -= elt.boundary
        ;({elt, index, parent} = parent!)
        index++
      } else {
        let next = elt.children[index]
        if (next.length <= dist) {
          if (walker) walker.skip(next)
          dist -= next.length
          index++
        } else {
          if (walker) walker.enter(next)
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

class ContentBuilder {
  children: ContentElt[] = []

  constructor(
    readonly tag: Tag | null,
    readonly prop: Prop | null,
    readonly parent: ContentBuilder | null,
    readonly reuse: ContentElt | null
  ) {}

  finish() {
    let len = this.children.reduce((l, ch) => l + ch.length, 0)
    let parent = this.parent!, dom = this.reuse ? this.reuse.dom as HTMLElement : null
    if (this.tag) {
      if (!dom) dom = renderNode(this.tag)
      // FIXME separate content DOM
      // FIXME add attribute props
      parent.children.push(new NodeElt(this.tag, this.children, len + 2, dom, dom))
    } else {
      if (!dom) dom = drawElement(this.prop!.type.spec.dom as ElementRepresentation<any>, this.prop!.value)
      parent.children.push(new WrapperElt(this.prop!, this.children, len, dom))
    }
    return parent
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

function renderNode(tag: Tag) { // FIXME draw attr props, deduplicate with DOM serializer?
  let {dom} = tag.type.spec
  return typeof dom == "function" ? dom(tag.param) : drawElement(dom, tag.param)
}

class ContentUpdate {
  old: ContentPointer
  new: ContentBuilder
  cursor: Context
  pendingWrappers: WrapperElt[] = []

  constructor(readonly doc: DocNode, old: DocElt) {
    this.old = new ContentPointer(old, 0, null)
    this.new = new ContentBuilder(doc.tag, null, null, old)
    this.cursor = doc.resolve(0)
  }

  // Make sure this.new has precisely the given set of spanning
  // wrappers, ordered outer first.
  syncWrappers(wrappers: readonly Prop[]) {
    let existing = [] // FIXME optimize
    for (let cx = this.new; cx.prop; cx = cx.parent!) existing.push(cx.prop)
    let keep = 0, index = 0
    while (index < wrappers.length && keep < existing.length) {
      let next = wrappers[index]
      if (next.type.element) {
        if (!next.type.spanning) break
        keep++
      }
      index++
    }
    for (let i = existing.length - keep; i > 0; i--) this.new = this.new.finish()
    for (let i = index; i < wrappers.length; i++) {
      let wrap = wrappers[i]
      if (wrap.type.element) {
        let found = this.pendingWrappers.find(v => v.prop.eq(wrap)) || null
        this.new = new ContentBuilder(null, wrappers[i], this.new, found)
      }
    }
  }

  // FIXME reuse of DOM nodes
  keep(len: number) {
    this.cursor = this.cursor.advance(len)
    let walk: ContentWalker = { // FIXME store in builder
      enter: v => {
        if (v.isSpanning()) {
          this.pendingWrappers.push(v)
        } else {
          this.syncWrappers(innerWrappers(v))
          this.new = new ContentBuilder(v.tag, v.prop, this.new, v)
        }
      },
      leave: v => {
        if (v instanceof NodeElt) {
          if (this.pendingWrappers.length) this.pendingWrappers = []
          for (;;) {
            let isTag = this.new.tag
            this.new = this.new.finish()
            if (isTag) break
          }
        }
      },
      skip: v => {
        // FIXME text join case
        if (v.isSpanning()) {
          walk.enter(v)
          for (let ch of v.children) walk.skip(ch)
          walk.leave(v)
        } else {
          let wrappers = innerWrappers(v)
          this.syncWrappers(v.prop ? wrappers.slice(0, wrappers.indexOf(v.prop)) : wrappers)
          if (this.pendingWrappers.length) this.pendingWrappers = []
          this.new.children.push(v)
        }
      }
    }
    this.old = this.old.advance(len, walk)
    if (this.pendingWrappers.length) this.pendingWrappers = []
  }

  replace(len: number, ins: number) {
    if (len) this.old.advance(len)
    let walk: Walker = {
      enter: tag => {
        this.syncWrappers(tag.props)
        for (let prop of tag.props) if (prop.type.element) {
          this.new = new ContentBuilder(null, prop, this.new, null)
        }
        this.new = new ContentBuilder(tag, null, this.new, null)
      },
      leave: () => {
        while (this.new.prop) this.new = this.new.finish()
        this.new = this.new.finish()
      },
      skip: node => {
        // FIXME text joinings
        if (node.isLeaf()) {
          this.syncWrappers(node.tag.props)
          if (node.isText())
            this.new.children.push(new TextElt(node.tag, [], node.length, document.createTextNode(node.text), null))
          else
            this.new.children.push(new NodeElt(node.tag, [], node.length, renderNode(node.tag), null))
        } else {
          walk.enter(node.tag)
          for (let ch of node.children) walk.skip(ch)
          walk.leave()
        }
      }
    }
    if (ins) this.cursor.advance(ins, walk)
  }

  finish() {
    while (this.new.parent) this.new = this.new.finish()
    return new DocElt(this.doc, this.new.children, this.doc.length, this.old.elt.dom as HTMLElement)
  }
}

function innerWrappers(elt: ContentElt) {
  while (elt instanceof WrapperElt) elt = elt.children[0]
  if (elt instanceof NodeElt) {
    return elt.tag.props
  } else {
    throw new Error("FIXME")
  }
}

export class DocElt extends ContentElt {
  constructor(readonly doc: DocNode, children: readonly ContentElt[], length: number, dom: HTMLElement) {
    super(children, length, dom, dom)
  }

  static create(doc: DocNode, dom: HTMLElement) {
    let empty = new DocElt(doc.schema.doc([]), [], 0, dom)
    return empty.update(doc, ChangeSet.create(empty.doc, {from: 0, insert: new Slice(doc.children)}))
  }

  update(doc: DocNode, changes: ChangeSet) {
    if (changes.empty) return this
    let builder = new ContentUpdate(doc, this)
    for (let i = 0; i < changes.sections.length;) {
      let data = changes.data[i >> 1], len = changes.sections[i++], ins = changes.sections[i++]
      if (!data) {
        builder.keep(len)
      } else {
        if (ins < 0) ins = len
        while (i < changes.sections.length && changes.data[i >> 1]) {
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
      }
      let next = parent.children[index]
      if (off + next.length > pos) {
        parent = next
        index = 0
        off += next.boundary
      } else {
        if (index == parent.children.length)
          throw new Error(`Invalid position ${pos} in document of size ${this.doc.length}`)
        index++
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

// FIXME render attribute props
export class NodeElt extends ContentElt {
  constructor(readonly _tag: Tag, readonly children: readonly ContentElt[], readonly length: number,
              dom: DOMNode, contentDOM: HTMLElement | null) {
    super(children, length, dom, contentDOM)
  }

  get boundary() { return 1 }

  get tag() { return this._tag }
}

export class TextElt extends NodeElt {
  get boundary() { return 0 }

  localPosFromDOM(dom: DOMNode, offset: number, bias: number) {
    return this.posAtStart + Math.min(offset, (this.tag.param as string).length)
  }
}

// FIXME actually create these
export class WrapperElt extends ContentElt {
  constructor(readonly _prop: Prop, readonly children: readonly ContentElt[], readonly length: number, dom: HTMLElement) {
    super(children, length, dom, dom)
  }

  get prop() { return this._prop }
}
