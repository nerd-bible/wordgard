import {Plot, Node, Leaf} from "./node"
import {Schema} from "./schema"
import {Slice, Token, TokenType} from "./slice"
import {Mark} from "./mark"
import {ElementShape, AttributeShape, isElementShape,
        Elt, Attributes, readAttributes, pushAttribute, mergeAttributes, noAttributes} from "./shape"

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
  let markAttrs: string[] = []
  for (let mark of node.tag.marks) if (!mark.type.element) {
    let repr = mark.type.repr as AttributeShape<any>
    let name = repr.attribute
    let value = typeof repr.value == "function" ? repr.value(mark.value) : repr.value ?? mark.value as string
    if (value != null) {
      if (/^style\//.test(name)) {
        value = name.slice(6) + ": " + value
        name = "style"
      }
      pushAttribute(markAttrs, name, value)
    }
  }
  let repr = node.type.spec.shape
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
  if (isElementShape(repr)) {
    let attrs = typeof repr.attributes == "function" ? repr.attributes(node.tag.param) : repr.attributes
    let allAttrs = !attrs ? markAttrs : mergeAttributes(readAttributes(attrs), markAttrs)
    return new Elt(repr.element, allAttrs, children)
  } else {
    let elt = typeof repr.structure == "function" ? repr.structure(node.tag.param) : repr.structure
    if (markAttrs.length) elt = new Elt(elt.tagName, mergeAttributes(elt.attrs, markAttrs), elt.children)
    return serializeStructure(elt, cx, children)
  }
}

function serializeStructure(elt: Elt<string>, cx: SerializeContext, content: Elt.Fragment): Elt {
  return new Elt(elt.tagName, elt.attrs, elt.children == null ? content : elt.children.map(ch => {
    if (typeof ch == "string") return ch
    else return serializeStructure(ch, cx, content)
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
  let active: Mark[] = [], top = new EltCx("", noAttributes, null)
  for (let child of children) {
    if (active.length || child.marks.some(p => isElementShape(p.type.repr))) {
      let keep = 0, rendered = 0, eltMarks = []
      for (let mark of child.marks)
        if (isElementShape(mark.type.repr)) eltMarks.push(mark)
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
        let repr = add.type.repr as ElementShape<any>
        let attrs = readAttributes(typeof repr.attributes == "function" ? repr.attributes(add.value) : repr.attributes)
        top = new EltCx(repr.element, attrs, top)
        active.push(add)
      }
    }
    top.children.push(serializeNodeInner(child, cx))
  }
  for (let i = 0; i < active.length; i++) top = top.pop()
  return top.children
}
