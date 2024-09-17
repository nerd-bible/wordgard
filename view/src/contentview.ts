import {DocNode, Tag, Prop, Context, Walker, ChangeSet, Slice, ElementRepresentation} from "@willows/doc"
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

  isSpanning(): this is PropView {
    return this instanceof PropView && this.prop.type.spanning && this.prop.type.element
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

  constructor(
    readonly tag: Tag | null,
    readonly prop: Prop | null,
    readonly parent: ViewBuilder | null,
    readonly reuse: ContentView | null
  ) {}

  finish() {
    let len = this.children.reduce((l, ch) => l + ch.length, 0)
    let parent = this.parent!, dom = this.reuse ? this.reuse.dom as HTMLElement : null
    if (this.tag) {
      if (!dom) dom = renderNode(this.tag)
      // FIXME separate contentView
      // FIXME add attribute props
      parent.children.push(new NodeView(this.tag, this.children, len + 2, dom, dom))
    } else {
      if (!dom) dom = drawElement(this.prop!.type.spec.dom as ElementRepresentation<any>, this.prop!.value)
      parent.children.push(new PropView(this.prop!, this.children, len, dom))
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

class ContentViewUpdate {
  old: ViewPointer
  new: ViewBuilder
  cursor: Context
  pendingWrappers: PropView[] = []

  constructor(readonly doc: DocNode, old: DocView) {
    this.old = new ViewPointer(old, 0, null)
    this.new = new ViewBuilder(doc.tag, null, null, old)
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
        this.new = new ViewBuilder(null, wrappers[i], this.new, found)
      }
    }
  }

  // FIXME reuse of DOM nodes
  keep(len: number) {
    this.cursor = this.cursor.advance(len)
    let walk: ViewWalker = { // FIXME store in builder
      enter: v => {
        if (v.isSpanning()) {
          this.pendingWrappers.push(v)
        } else {
          this.syncWrappers(innerWrappers(v))
          this.new = new ViewBuilder(v.tag, v.prop, this.new, v)
        }
      },
      leave: v => {
        if (v instanceof NodeView) {
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
          this.new = new ViewBuilder(null, prop, this.new, null)
        }
        this.new = new ViewBuilder(tag, null, this.new, null)
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
            this.new.children.push(new TextView(node.tag, [], node.length, document.createTextNode(node.text), null))
          else
            this.new.children.push(new NodeView(node.tag, [], node.length, renderNode(node.tag), null))
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
    return new DocView(this.doc, this.new.children, this.doc.length, this.old.view.dom as HTMLElement)
  }
}

function innerWrappers(view: ContentView) {
  while (view instanceof PropView) view = view.children[0]
  if (view instanceof NodeView) {
    return view.tag.props
  } else {
    throw new Error("FIXME")
  }
}

export class DocView extends ContentView {
  constructor(readonly doc: DocNode, children: readonly ContentView[], length: number, dom: HTMLElement) {
    super(children, length, dom, dom)
  }

  static create(doc: DocNode, dom: HTMLElement) {
    let empty = new DocView(doc.schema.doc([]), [], 0, dom)
    return empty.update(doc, ChangeSet.create(empty.doc, {from: 0, insert: new Slice(doc.children)}))
  }

  update(doc: DocNode, changes: ChangeSet) {
    if (changes.empty) return this
    let builder = new ContentViewUpdate(doc, this)
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

// FIXME render attribute props
export class NodeView extends ContentView {
  constructor(readonly _tag: Tag, readonly children: readonly ContentView[], readonly length: number,
              dom: DOMNode, contentDOM: HTMLElement | null) {
    super(children, length, dom, contentDOM)
  }

  get boundary() { return 1 }

  get tag() { return this._tag }
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
