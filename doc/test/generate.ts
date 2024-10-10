import {Node, Tag, Prop, DocNode, TextNode, PropType,
        Slice, Token, OpenToken, CloseToken, ChangeSet,
        basicBuilders, ChangeSpec,
        Paragraph, Blockquote, CodeBlock, CodeBlockLanguage,
        Emphasis, Strong, Code, Link} from "@willows/doc"
const {doc, p, h1, pre, ul, ol, li, blockquote, img, br} = basicBuilders

export const Comment = PropType.define<readonly number[]>("Comment", {
  tags: "Inline",
  set: {compare: (a, b) => a - b},
  dom: {attribute: "data-comment", value: ids => ids.join(" "), readAttribute: value => value.split(" ").map(v => Number(v))}
})

export function open(node: Node) { return new OpenToken(node.tag) }
export const close = CloseToken

export function slice(...tokens: (Token | string)[]) {
  return new Slice(tokens.map(t => typeof t == "string" ? Node.text(t) : t))
}

export function permute<T>(array: readonly T[]): readonly (readonly T[])[] {
  if (array.length < 2) return [array]
  let result = []
  for (let i = 0; i < array.length; i++) {
    let others = permute(array.slice(0, i).concat(array.slice(i + 1)))
    for (let j = 0; j < others.length; j++)
      result.push([array[i]].concat(others[j]))
  }
  return result
}

export function r(n: number) { return Math.floor(Math.random() * n) }

function rLetter() { return String.fromCharCode(97 + r(26)) }

function rWord(len = 2 + r(5)) {
  let word = ""
  for (let i = 0; i < len; i++) word += rLetter()
  return word
}

export function rDoc(minLength: number) {
  let stack: {tag: Tag, children: Node[]}[] = [{tag: doc().tag, children: []}]
  let len = 0
  function open() {
    while (!r(5)) {
      for (let type of r(1) ? [blockquote()] : [r(1) ? ul() : ol(), li()]) {
        stack.push({tag: type.tag, children: []})
        len++
      }
    }
    stack.push({tag: (r(5) ? p() : r(2) ? pre() : h1()).tag, children: []})
    len++
  }
  function closeOne() {
    let top = stack.pop()!
    stack[stack.length - 1].children.push(top.tag.create(top.children))
    len++
  }
  function close() {
    closeOne()
    while (stack.length > 1 && (!stack[stack.length - 1].tag.type.canContain(Paragraph.type) || r(3))) closeOne()
  }
  do {
    open()
    let props: readonly Prop[] = []
    for (let i = 0, elements = r(7); i < elements * 2 - 1; i++) {
      let node: Node
      if (i % 2) {
        if (props.length && !r(3))
          props = props[r(props.length)].removeFromSet(props)
        node = Node.text(" ", props)
      } else {
        if (!r(5)) {
          let prop = r(2) ? (r(2) ? Emphasis : Strong) : (r(2) ? Code : Link.of("/" + rWord()))
          props = prop.addToSet(props)
        }
        node = r(5) ? Node.text(rWord()) : r(2) ? br() : img(rWord() + ".svg")
        node = node.withProps(props)
      }
      len += node.length
      let {children} = stack[stack.length - 1], last = children.length ? children[children.length - 1] : null
      if (node.isText() && last && last.isText() && last.tag.sameProps(node.tag))
        children[children.length - 1] = Node.text((last as TextNode).text + node.text, node.tag.props)
      else 
        children.push(node)
    }
    close()
  } while (len < minLength)
  while (stack.length > 1) closeOne()
  return doc(stack[0].children)
}

export function rChangeSpec(doc: DocNode) {
  for (let i = 0; i < 100; i++) {
    let change = generators[r(generators.length)](doc)
    if (change) return change
  }
  throw new Error("Failed to generate a change for document " + doc)
}

const generators: ((doc: DocNode) => ChangeSpec | null)[] = [
  // Insert a few characters
  doc => {
    let pos = doc.resolve(r(doc.length))
    return pos.node.inlineContent() ? {from: pos.pos, insert: slice(rWord(1 + r(3)))} : null
  },
  // Delete some inline content
  doc => {
    let pos = r(doc.length), cx = doc.resolve(pos)
    if (!cx.node.inlineContent() || cx.start == cx.end) return null
    let from = pos > cx.start ? pos - 1 : pos
    return {from, to: pos < cx.end && (from == pos || r(2)) ? pos + 1 : pos}
  },
  // Join two adjacent blocks
  doc => scanBlocks(doc, (node, pos, parent, index) => {
    if (index && parent.children[index - 1].tag.type.sharesContent(node.tag.type))
      return {from: pos - 1, to: pos + 1}
  }),
  // Lift a block's content out to its parent
  doc => scanBlocks(doc, (node, pos, parent) => {
    if (parent.tag.type.sharesContent(node.tag.type))
      return [{from: pos, to: pos + 1}, {from: pos + node.length - 1, to: pos + node.length}]
  }),
  // Wrap a block in a blockquote
  doc => scanBlocks(doc, (node, pos, parent) => {
    if (parent.tag.type.canContain(Blockquote.type) && Blockquote.type.canContain(node.tag.type))
      return [{from: pos, insert: slice(open(blockquote()))},
              {from: pos + node.length, insert: slice(close)}]
  }),
  // Delete an entire node
  doc => scanBlocks(doc, (node, pos, parent) => {
    if (parent.children.length > 1) return {from: pos, to: pos + node.length}
  }),
  // Mark some inline content
  doc => {
    let len = 2 + r(6), from = r(doc.length - len)
    return {from, to: from + len, add: !r(4) ? Comment.of([r(100)]) : !r(3) ? Emphasis : r(2) ? Strong : Link.of("/" + rWord())}
  },
  // Remove a prop from some textblock
  doc => scanBlocks(doc, (node, pos) => {
    if (node.isTextblock()) for (let i = 0; i < node.children.length; i++) {
      let props = node.children[i].tag.props
      if (props.length) {
        return {from: pos, to: pos + node.length, remove: props[r(props.length)]}
      }
    }
  }),
  // Change a prop on some list or code block
  doc => scanBlocks(doc, (node, pos) => {
    if (node.tag == CodeBlock)
      return {from: pos, add: CodeBlockLanguage.of(rWord())}
  })
]

function scanBlocks<T>(doc: DocNode, f: (node: Node, pos: number, parent: Node, index: number) => T | null | undefined): T | null {
  let found: T[] = []
  function explore(node: Node, off: number) {
    for (let i = 0, pos = off; i < node.children.length; i++) {
      let child = node.children[i], val = f(child, pos, node, i)
      if (val != null) found.push(val)
      if (!child.inlineContent()) explore(child, pos + 1)
      pos += child.length
    }
  }
  explore(doc, 0)
  return found.length ? found[r(found.length)] : null
}

export function rChange(doc: DocNode, parts = 1) {
  let specs: ChangeSpec[] = []
  for (let i = 0; i < parts; i++) specs.push(rChangeSpec(doc))
  return ChangeSet.create(doc, {correct: specs})
}
