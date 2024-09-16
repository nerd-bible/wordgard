import {DocNode, Node, Tag, Prop, Context, ChangeSet, ElementRepresentation} from "@willows/doc"
import {DOMNode} from "./dom"

declare global {
  interface Node { wsView?: ContentView }
}

export class ViewPos {
  constructor(
    readonly view: ContentView,
    readonly offset: number,
    readonly pos: number
  ) {}

  get node(): DOMNode { return this.view.contentDOM || this.view.dom }

  get nearestNode(): Tag {
    let {view} = this
    while (!(view instanceof NodeView)) view = view.parent!
    return view.tag
  }
}

export abstract class ContentView {
  parent: ContentView | null = null

  constructor(
    readonly children: readonly ContentView[],
    readonly length: number,
    readonly dom: DOMNode,
    readonly contentDOM: HTMLElement | null
  ) {
    dom.wsView = this
    let prev: DOMNode | null = null, next
    if (contentDOM) {
      for (let child of children) {
        child.parent = this
        next = prev ? prev.nextSibling : contentDOM.firstChild
        if (child.dom.parentNode == contentDOM) {
          while (next && next != child.dom) next = rm(next)
        } else {
          contentDOM.insertBefore(child.dom, next)
        }
        prev = child.dom
      }
      while (next) next = rm(next)
    } else if (children.length) {
      throw new Error("FIXME")
    }
  }

  posBeforeChild(child: ContentView): number {
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
      let domBefore, view: ContentView | undefined
      if (dom == this.contentDOM) {
        domBefore = dom.childNodes[offset - 1]
      } else {
        while (dom.parentNode != this.contentDOM) dom = dom.parentNode!
        domBefore = dom.previousSibling
      }
      while (domBefore && !((view = domBefore.wsView) && view.parent == this)) domBefore = domBefore.previousSibling
      return domBefore ? this.posBeforeChild(view!) + view!.length : this.posAtStart
    }
    // Otherwise, use various heuristics, falling back on the bias
    // parameter, to determine whether to return the position at the
    // start or at the end of this view desc.
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

interface ViewWalker {
  enter(view: ContentView): void
  skip(view: ContentView): void
  leave(view: ContentView): void
}

class ViewPointer {
  constructor(readonly view: ContentView, public index: number, readonly parent: ViewPointer | null) {}

  advance(dist: number, walker?: ViewWalker) {
    let {view, index, parent} = this
    while (dist > 0) {
      if (index == view.children.length) {
        if (walker) walker.leave(view)
        dist -= view.boundary
        ;({view, index, parent} = parent!)
        index++
      } else {
        let next = view.children[index]
        if (next.length <= dist) {
          if (walker) walker.skip(next)
          dist -= next.length
          index++
        } else {
          if (walker) walker.enter(next)
          dist -= next.boundary
          parent = new ViewPointer(view, index, parent)
          view = next
          index = 0
        }
      }
    }
    return new ViewPointer(view, index, parent)
  }
}

class ViewBuilder {
  children: ContentView[] = []

  constructor(readonly tag: Tag | null, readonly prop: Prop | null, readonly parent: ViewBuilder | null) {}

  finish() {
    let len = this.children.reduce((l, ch) => l + ch.length, 0), view
    // FIXME reuse existing DOM when possible
    if (this.tag) {
      let dom = renderNode(this.tag)
      // FIXME separate contentView
      view = new NodeView(this.tag, this.children, len + 2, dom, dom)
    } else {
      view = new PropView(this.prop!, this.children, len,
                          drawElement(this.prop!.type.spec.dom as ElementRepresentation<any>, this.prop!.value))
    }
    let parent = this.parent!
    parent.children.push(view)
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

class ContentViewUpdate {
  old: ViewPointer
  new: ViewBuilder

  constructor(readonly doc: DocNode, old: DocView) {
    this.old = new ViewPointer(old, 0, null)
    this.new = new ViewBuilder(doc.tag, null, null)
  }

  copy(len: number) {
    this.old = this.old.advance(len, {
      enter: v => this.new = new ViewBuilder(v.tag, v.prop, this.new),
      leave: () => this.new = this.new.finish(),
      skip: v => this.new.children.push(v),
    })
  }

  skip(len: number) {
    this.old.advance(len)
  }

  build(cursor: Context, len: number) {
    cursor.advance(len, {
      enter: tag => this.new = new ViewBuilder(tag, null, this.new),
      leave: () => this.new = this.new.finish(),
      skip: node => this.new.children.push(NodeView.build(node))
    })
  }

  finish() {
    return new DocView(this.doc, this.new.children, this.doc.length, this.old.view.dom as HTMLElement)
  }
}

export class DocView extends ContentView {
  constructor(readonly doc: DocNode, children: readonly ContentView[], length: number, dom: HTMLElement) {
    super(children, length, dom, dom)
  }

  static build(doc: DocNode, dom: HTMLElement) {
    return new DocView(doc, doc.children.map(ch => NodeView.build(ch)), doc.length, dom)
  }

  update(doc: DocNode, changes: ChangeSet) {
    if (changes.empty) return this
    let builder = new ContentViewUpdate(doc, this)
    let cursor = Context.atStart(doc)
    for (let i = 0; i < changes.sections.length;) {
      let data = changes.data[i >> 1], len = changes.sections[i++], ins = changes.sections[i++]
      if (!data) {
        builder.copy(len)
        cursor = cursor.advance(len)
      } else {
        if (ins < 0) ins = len
        while (i < changes.sections.length && changes.data[i >> 1]) {
          let len2 = changes.sections[i++], ins2 = changes.sections[i++]
          len += len2; ins += ins2 < 0 ? len2 : ins2
        }
        builder.skip(len)
        builder.build(cursor, ins)
      }
    }
    return builder.finish()
  }

  nearestNodeView(dom: DOMNode) {
    for (let cur: DOMNode | null = dom; cur; cur = cur.parentNode) {
      let view = cur.wsView
      if (view instanceof NodeView && this.owns(view)) return view
    }
    return null
  }

  nearest(dom: DOMNode) {
    for (let cur: DOMNode | null = dom; cur; cur = cur.parentNode) {
      let view = cur.wsView
      if (view && this.owns(view)) return view
    }
    return null
  }

  owns(view: ContentView) {
    for (;;) {
      let {parent} = view
      if (parent == this) return true
      if (!parent) return false
      view = parent
    }
  }

  resolve(pos: number, assoc: -1 | 1) {
    let parent: ContentView = this, index = 0, off = 0
    for (;;) {
      if (parent.tag?.isText()) return new ViewPos(parent, pos - off, pos)
      if (off == pos) {
        let before = index ? parent.children[index - 1] : null
        let after = index < parent.children.length ? parent.children[index] : null
        if (before?.boundary) before = null
        if (after?.boundary) after = null
        if (!before && !after) return new ViewPos(parent, index, pos)
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
    let view = this.nearest(dom)
    if (!view) throw new RangeError("Trying to find position for a DOM position outside of the document")
    return view.localPosFromDOM(dom, offset, bias)
  }

  connect() {
    // FIXME
  }

  disconnect() {
    // FIXME must determine disconnected views during update
  }
}

export class NodeView extends ContentView {
  constructor(readonly _tag: Tag, readonly children: readonly ContentView[], readonly length: number,
              dom: DOMNode, contentDOM: HTMLElement | null) {
    super(children, length, dom, contentDOM)
  }

  get boundary() { return 1 }

  get tag() { return this._tag }

  // FIXME this approach cannot build spanning props
  static build(node: Node): NodeView {
    if (node.isText()) {
      return new TextView(node.tag, [], node.length, document.createTextNode(node.text), null)
    } else {
      let dom = renderNode(node.tag)
      // FIXME separate content view
      return new NodeView(node.tag, node.children.map(ch => NodeView.build(ch)), node.length, dom, node.isLeaf() ? null : dom)
    }
  }
}

export class TextView extends NodeView {
  get boundary() { return 0 }

  localPosFromDOM(dom: DOMNode, offset: number, bias: number) {
    return this.posAtStart + Math.min(offset, (this.tag.param as string).length)
  }
}

// FIXME actually create these
export class PropView extends ContentView {
  constructor(readonly _prop: Prop, readonly children: readonly ContentView[], readonly length: number, dom: HTMLElement) {
    super(children, length, dom, dom)
  }

  get prop() { return this._prop }
}
