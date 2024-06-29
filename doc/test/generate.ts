import {Node, DocNode, TextNode, Mark,
        Slice, Token, OpenToken, CloseToken,
        basicBuilder, ChangeSpec,
        Paragraph, Emphasis, Strong, Code, Link} from "@willow/doc"
const {doc, p, h1, pre, ul, ol, li, blockquote, img, br} = basicBuilder

export function open(node: Node) { return new OpenToken(node) }
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

const mEm = Emphasis.create(), mStrong = Strong.create(), mCode = Code.create()

export function r(n: number) { return Math.floor(Math.random() * n) }

function rWord() {
  let len = 2 + r(5), word = ""
  for (let i = 0; i < len; i++)
    word += String.fromCharCode(97 + r(26))
  return word
}

export function rDoc(minLength: number) {
  let stack: {type: Node, children: Node[]}[] = [{type: doc(), children: []}]
  let len = 0
  function open() {
    while (!r(5)) {
      for (let type of r(1) ? [blockquote()] : [r(1) ? ul() : ol(), li()]) {
        stack.push({type, children: []})
        len++
      }
    }
    stack.push({type: r(5) ? p() : r(2) ? pre() : h1(), children: []})
    len++
  }
  function closeOne() {
    let top = stack.pop()!
    stack[stack.length - 1].children.push(top.type.copy(top.children))
    len++
  }
  function close() {
    closeOne()
    while (stack.length > 1 && (!stack[stack.length - 1].type.type.canContain(Paragraph) || r(3))) closeOne()
  }
  do {
    open()
    let marks: readonly Mark[] = []
    for (let i = 0, elements = r(7); i < elements * 2 - 1; i++) {
      let node: Node
      if (i % 2) {
        if (marks.length && !r(3)) {
          let cut = r(marks.length)
          marks = marks.filter((_, i) => i != cut)
        }
        node = Node.text(" ").mark(marks)
      } else {
        if (!r(5)) {
          let mark = r(2) ? (r(2) ? mEm : mStrong) : (r(2) ? mCode : Link.create({href: "/" + rWord()}))
          marks = mark.addToSet(marks)
        }
        node = (r(5) ? Node.text(rWord()) : r(2) ? br() : img({src: rWord() + ".svg"})).mark(marks)
      }
      len += node.length
      let {children} = stack[stack.length - 1], last = children.length ? children[children.length - 1] : null
      if (node.isText() && last && last.sameMarkup(node))
        children[children.length - 1] = node.withText((last as TextNode).text + node.text)
      else 
        children.push(node)
    }
    close()
  } while (len < minLength)
  while (stack.length > 1) closeOne()
  return doc(stack[0].children)
}

export function rChangeSpec(doc: DocNode) {
  for (;;) {
    let change = generators[r(generators.length)](doc)
    if (change) return change
  }
}

const generators: ((doc: DocNode) => ChangeSpec | null)[] = [
  // Insert a character
  doc => {
    // let pos = doc.resolve(r(doc.length))
    // return pos.node.inlineContent() ? {from: pos.pos, insert: 
    return null
  }
]
