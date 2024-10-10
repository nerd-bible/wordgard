import {Slice, Text, Node, Context, serializeSlice, parseSlice,
        OpenSide, Token, CloseToken, OpenToken} from "@willows/doc"
import {EditorState} from "@willows/state"
import browser from "./browser"

export function writeClipboard(state: EditorState, slice: Slice, data: DataTransfer) {
  // FIXME clipboard output transform facet
  // FIXME determine defining context nodes and props
  let doc = detachedDoc(), dom = serializeSlice(slice, {
    document: doc,
    schema: state.doc.schema,
    markOpen: (elt, open) => {
      elt.setAttribute("ws-open", open == OpenSide.Start ? "start" : open == OpenSide.End ? "end" : "start end")
    }
  })

  let needsWrap, wrappers = 0
  while (dom.firstChild && dom.firstChild.nodeType == 1 && (needsWrap = wrapMap[dom.firstChild.nodeName.toLowerCase()])) {
    for (let i = needsWrap.length - 1; i >= 0; i--) {
      let wrapper = doc.createElement(needsWrap[i])
      wrapper.setAttribute("ws-wrap", "true")
      while (dom.firstChild) wrapper.appendChild(dom.firstChild)
      dom.appendChild(wrapper)
      wrappers++
    }
  }

  if (dom.firstChild && dom.firstChild.nodeType == 1)
    (dom.firstChild as HTMLElement).setAttribute("ws-content", "true")

  let wrap = doc.createElement("div")
  wrap.appendChild(dom)
  data.setData("text/html", wrap.innerHTML)
  data.setData("text/plain", wrap.textContent!) // FIXME
}

function isOpen(elt: HTMLElement) {
  let value = elt.getAttribute("ws-open")
  return value == "start" ? OpenSide.Start : value == "end" ? OpenSide.End : value ? OpenSide.Both : OpenSide.None
}

// FIXME choice between text and HTML. Check context?
export function readClipboard(state: EditorState, data: DataTransfer, context: Context, plain: boolean) {
  let html = data.getData("text/html")
  let text = data.getData("text/plain") || data.getData("Text") || data.getData("text/uri-list").replace(/\r?\n/g, " ")
  if (text && (context.node.type.preserveWhitespace || !html || plain))
    return text ? {slice: readClipboardText(state, text, context, plain), context: []} : null

  // FIXME transform HTML
  let dom = readHTML(html)
  if (browser.webkit) restoreReplacedSpaces(dom)

  let fromWillows = !!dom.querySelector("[ws-content=true]")
  let slice = parseSlice(state.doc.schema, dom, {
    collapseWhiteSpace: !fromWillows,
    isOpen: fromWillows ? isOpen : undefined
    // FIXME strip suspicious trailing <br>s somehow
  })
  // FIXME transform slice
  return slice
}

function readClipboardText(state: EditorState, text: string, context: Context, plain: boolean) {
  // FIXME text filtering, custom parsers
  let props = plain ? [] : context.props()
  if (context.node.tag.type.preserveWhitespace) return new Slice([Node.text(text.replace(/\r?\n|\r/g, "\n"), props)])
  let lines = text.split(/(?:\r\n?|\n)+/)
  let content: Token[] = lines[0] ? [Node.text(lines[0], props)] : []
  if (lines.length == 1) return new Slice(content)
  let parent = (context.node.inlineContent() ? context.parent || context : context).node.tag
  let wrapping = state.doc.schema.findWrapping(parent, Text)
  if (!wrapping || !wrapping.length) return new Slice([Node.text(text.replace(/\r?\n|\r/g, " "), props)])
  let wrapper = wrapping[wrapping.length - 1]
  content.push(CloseToken)
  for (let i = 1; i < lines.length - 1; i++)
    content.push(wrapper.create(lines[i] ? [Node.text(lines[i], props)] : []))
  content.push(new OpenToken(wrapper))
  let last = lines[lines.length - 1]
  if (last) content.push(Node.text(last, props))
  return new Slice(content)
}

// Trick from jQuery -- some elements must be wrapped in other
// elements for innerHTML to work. I.e. if you do `div.innerHTML =
// "<td>..</td>"` the table cells are ignored.
const wrapMap: {[node: string]: string[]} = {
  thead: ["table"],
  tbody: ["table"],
  tfoot: ["table"],
  caption: ["table"],
  colgroup: ["table"],
  col: ["table", "colgroup"],
  tr: ["table", "tbody"],
  td: ["table", "tbody", "tr"],
  th: ["table", "tbody", "tr"]
}

let _detachedDoc: Document | null = null
function detachedDoc() {
  return _detachedDoc || (_detachedDoc = document.implementation.createHTMLDocument("title"))
}

function maybeWrapTrusted(html: string): string {
  let trustedTypes = (window as any).trustedTypes
  if (!trustedTypes) return html
  // With the require-trusted-types-for CSP, Chrome will block
  // innerHTML, even on a detached document. This wraps the string in
  // a way that makes the browser allow us to use its parser again.
  return trustedTypes.createPolicy("detachedDocument", {createHTML: (s: string) => s}).createHTML(html)
}

function readHTML(html: string) {
  let metas = /^(\s*<meta [^>]*>)*/.exec(html)
  if (metas) html = html.slice(metas[0].length)
  let elt = detachedDoc().createElement("div")
  let firstTag = /<([a-z][^>\s]+)/i.exec(html), wrap
  if (wrap = firstTag && wrapMap[firstTag[1].toLowerCase()])
    html = wrap.map(n => "<" + n + ">").join("") + html + wrap.map(n => "</" + n + ">").reverse().join("")
  elt.innerHTML = maybeWrapTrusted(html)
  if (wrap) for (let i = 0; i < wrap.length; i++) elt = elt.querySelector(wrap[i]) || elt
  return elt
}

// Webkit browsers do some hard-to-predict replacement of regular
// spaces with non-breaking spaces when putting content on the
// clipboard. This tries to convert such non-breaking spaces (which
// will be wrapped in a plain span on Chrome, a span with class
// Apple-converted-space on Safari) back to regular spaces.
function restoreReplacedSpaces(dom: HTMLElement) {
  let nodes = dom.querySelectorAll(browser.chrome ? "span:not([class]):not([style])" : "span.Apple-converted-space")
  for (let i = 0; i < nodes.length; i++) {
    let node = nodes[i]
    if (node.childNodes.length == 1 && node.textContent == "\u00a0" && node.parentNode)
      node.parentNode.replaceChild(dom.ownerDocument.createTextNode(" "), node)
  }
}
