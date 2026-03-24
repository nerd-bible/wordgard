import {Plot, Node, Leaf} from "./node"
import {Schema} from "./schema"
import {Slice, Token, TokenType} from "./slice"
import {Mark} from "./mark"
import {Elt, Attributes} from "./shape"

export type SerializeOptions = {
  emitNewlines?: boolean
}

class SerializeContext {
  constructor(readonly emitNewlines: boolean, readonly schema: Schema) {}
}

export function serialize(doc: Plot.Doc, options: SerializeOptions = {}): Elt.Fragment {
  return serializeChildren(doc.content, new SerializeContext(options.emitNewlines !== false, doc.schema))
}

export function serializeNode(node: Node, options: SerializeOptions & {schema: Schema}): Elt | string {
  return serializeChildren([node], new SerializeContext(options.emitNewlines !== false, options.schema))[0]
}

const genericTag = Plot.defineBlock("generic", {
  blockContent: Node.Group.All,
  shape: {element: "div"}
})

function flattenSlice(
  content: readonly Token[],
  context: readonly Plot.Tag.Any[], includeContext: number,
  openMark?: Mark.Type<string>
): readonly Node[] {
  let depth = 0, i = 0, scan = (inner: boolean): readonly Node[] => {
    let result: Node[] = []
    for (; i < content.length;) {
      let tok = content[i++]
      if (tok.tokenType == TokenType.Close) {
        if (inner) break
        let tag = depth < context.length ? context[depth++] : genericTag
        if (openMark) tag = tag.withMarks(openMark.of("start").addToSet(tag.marks))
        result = [tag.create(result)]
      } else if (tok.tokenType == TokenType.Open) {
        let content = scan(true), tag = tok
        if (openMark) tag = tag.withMarks(openMark.of("end").addToSet(tag.marks))
        result.push(tag.create(content))
      } else {
        result.push(tok)
      }
    }
    return result
  }
  let result = scan(false)
  while (depth < includeContext && depth < context.length) {
    let tag = context[depth++]
    if (openMark) tag = tag.withMarks(openMark.of("start end").addToSet(tag.marks))
    result = [tag.create(result)]
  }
  return result
}

export function serializeSlice(slice: Slice, options: SerializeOptions & {
  schema: Schema,
  openMark?: Mark.Type<string>,
  context?: readonly Plot.Tag.Any[],
  includeContext?: number
}): Elt.Fragment {
  return serializeChildren(flattenSlice(slice.content, options.context || [], options.includeContext || 0, options.openMark),
                           new SerializeContext(options.emitNewlines !== false, options.schema))
}

function serializeNodeInner(node: Node, cx: SerializeContext) {
  let markAttrs: Attributes = Attributes.none, targeted: {attrs: Attributes, target: Elt.Selector}[] | undefined
  for (let mark of node.tag.marks) if (mark.type.attribute) {
    let {target, get} = mark.type.attribute, attrs = get(mark.value)
    if (target && !node.isText) {
      ;(targeted || (targeted = [])).push({attrs, target})
    } else if (!node.isText || mark.spanning) {
      markAttrs = Attributes.merge(markAttrs, attrs)
    }
  }
  let shape = node.type.shape
  if (node.is(Leaf.Text))
    return markAttrs.length ? new Elt("span", markAttrs, [node.param]) : node.param
  let children: Elt.Fragment
  if (node.isLeaf) {
    children = []
  } else {
    let {content} = node
    if (cx.emitNewlines && node.type.preserveWhitespace && cx.schema.lineBreak)
      content = lineBreaksToNewlines(content, cx.schema.lineBreak)
    children = serializeChildren(content, cx)
  }
  let elt = shape.create(node.tag.param)
  if (markAttrs.length) elt = elt.addAttrs(markAttrs)
  if (targeted) for (let {attrs, target} of targeted) elt = elt.addAttrs(attrs, target)
  return shape.atom ? elt : withContent(elt, children)
}

function withContent(elt: Elt<string>, content: Elt.Fragment): Elt<string> {
  return new Elt(elt.tagName, elt.attrs, elt.children == null ? content : elt.children.map(ch => {
    if (typeof ch == "string" || !ch.hasContent) return ch
    else return withContent(ch, content)
  }))
}

function lineBreaksToNewlines(nodes: readonly Node[], lineBreak: Leaf.Any) {
  if (!nodes.some(n => n.is(lineBreak.type))) return nodes
  let result: Node[] = [], lastText = false
  for (let node of nodes) {
    let next = node.is(lineBreak.type) ? Leaf.text("\n", node.marks) : node
    if (lastText && next instanceof Plot) next.pushTo(result as Plot[])
    else result.push(next)
    lastText = next.isText
  }
  return result
}

class EltCx {
  children: (Elt | string)[] = []
  constructor(readonly tagName: string, readonly attrs: Attributes, readonly parent: EltCx | null) {}
  pop() {
    let repr = new Elt(this.tagName, this.attrs, this.children)
    let parent = this.parent!
    parent.children.push(repr)
    return parent
  }
}

function serializeChildren(children: readonly Node[], cx: SerializeContext): Elt.Fragment {
  let active: Mark[] = [], top = new EltCx("", Attributes.none, null)
  for (let child of children) {
    if (active.length || child.marks.some(p => p.type.element)) {
      let keep = 0, rendered = 0, eltMarks = []
      for (let mark of child.marks)
        if (mark.type.element) eltMarks.push(mark)
      while (keep < active.length && rendered < eltMarks.length) {
        let next = eltMarks[rendered]
        if (!next.eq(active[keep]) || !next.type.spanning) break
        keep++; rendered++
      }
      while (keep < active.length) {
        top = top.pop()
        active.pop()
      }
      while (rendered < eltMarks.length) {
        let add = eltMarks[rendered++]
        let repr = add.type.element!
        top = new EltCx(repr.name, repr.attrs(add.value), top)
        active.push(add)
      }
    }
    top.children.push(serializeNodeInner(child, cx))
  }
  for (let i = 0; i < active.length; i++) top = top.pop()
  return top.children
}
