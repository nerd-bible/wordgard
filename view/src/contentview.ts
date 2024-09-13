import {DocNode, Node, Tag, Prop, Context, ChangeSet, ElementRepresentation} from "@willows/doc"
import {DOMNode} from "./dom"

export abstract class ContentView {
  constructor(
    readonly children: readonly ContentView[],
    readonly length: number,
    readonly dom: DOMNode
  ) {
    let prev: DOMNode | null = null, next
    for (let child of children) {
      next = prev ? prev.nextSibling : dom.firstChild
      if (child.dom.parentNode == dom) {
        while (next && next != child.dom) next = rm(next)
      } else {
        dom.insertBefore(child.dom, next)
      }
      prev = child.dom
    }
    while (next) next = rm(next)
  }

  get boundary() { return 0 }
  get tag(): Tag | null { return null }
  get prop(): Prop | null { return null }
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
          parent = new ViewPointer(next, index, parent)
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
    let len = this.children.reduce((l, ch) => l + ch.length, 0)
    // FIXME reuse existing DOM when possible
    let view = this.tag ? new NodeView(this.tag, this.children, len + 2, renderNode(this.tag))
      : new PropView(this.prop!, this.children, len,
                     drawElement(this.prop!.type.spec.dom as ElementRepresentation<any>, this.prop!.value))
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
    super(children, length, dom)
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

  connect() {
    // FIXME
  }

  disconnect() {
    // FIXME
  }
}

export class NodeView extends ContentView {
  constructor(readonly _tag: Tag, readonly children: readonly ContentView[], readonly length: number, dom: DOMNode) {
    super(children, length, dom)
  }

  get boundary() { return 1 }

  get tag() { return this._tag }

  // FIXME this approach cannot build spanning props
  static build(node: Node): NodeView {
    return new NodeView(node.tag, node.children.map(ch => NodeView.build(ch)), node.length, renderNode(node.tag))
  }
}

// FIXME actually create these
export class PropView extends ContentView {
  constructor(readonly _prop: Prop, readonly children: readonly ContentView[], readonly length: number, dom: DOMNode) {
    super(children, length, dom)
  }

  get prop() { return this._prop }
}
