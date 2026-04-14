import {elt, ParseRule, Plot, Leaf, Node, Mark, Schema} from "wordgard/doc"

const G = Node.Group

export const Paragraph = Plot.defineBlock("Paragraph", {
  inlineContent: true,
  group: G.Content,
  defaultBlock: true,
  shape: {element: "p"}
})

export const Heading = Plot.Type.defineBlock("Heading", {
  defaultParam: 1,
  validateParam: "number",
  inlineContent: true,
  group: G.Content,
  shape: {structure: level => elt("h" + level, 0), atom: false},
  defining: true,
  parseRules: [
    {selector: "h1", param: 1},
    {selector: "h2", param: 2},
    {selector: "h3", param: 3},
    {selector: "h4", param: 4},
    {selector: "h5", param: 5},
    {selector: "h6", param: 6},
  ]
})

export const CodeBlock = Plot.defineBlock("CodeBlock", {
  inlineContent: true,
  group: G.Content,
  role: Node.Role.Code,
  shape: {element: "pre"},
})

export const Alignment = Mark.Type.define<"end" | "center">("Alignment", {
  role: Mark.Role.Alignment,
  target: G.Textblock,
  keepOnSplit: true,
  keepOnTypeChange: true,
  shape: {attribute: "style", value: align => `text-align: ${align}`},
  parseRules: [
    {attribute: "style/text-align", readAttribute: value => /^(end|center)$/.test(value) ? value as any : ParseRule.Reject}
  ]
})

export const CodeBlockLanguage = Mark.Type.define<string>("CodeBlockLanguage", {
  target: CodeBlock,
  validate: "string",
  shape: {attribute: "data-language", value: 0}
})

export const Blockquote = Plot.defineBlock("Blockquote", {
  blockContent: G.Content,
  group: G.Content,
  shape: {element: "blockquote"},
  autoJoin: true
})

export const ListItem = Plot.defineBlock("ListItem", {
  blockContent: G.Content,
  shape: {element: "li"},
  defining: true,
})

export const OrderedList = Plot.Type.defineBlock("OrderedList", {
  defaultParam: 1,
  validateParam: "number",
  blockContent: ListItem,
  group: G.Content,
  role: Node.Role.List,
  defining: true,
  shape: {
    element: "ol",
    attributes: order => order == 1 ? {} as Record<string, string> : {order: String(order)},
    read: elt => Number(elt.getAttribute("order") || "1")
  },
  autoJoin: (_a, b) => b.param == 1
})

export const BulletList = Plot.defineBlock("BulletList", {
  blockContent: ListItem,
  group: G.Content,
  role: Node.Role.List,
  defining: true,
  shape: {element: "ul"},
  autoJoin: true
})

export const HorizontalRule = Leaf.defineBlock("HorizontalRule", {
  group: G.Content,
  shape: {element: "hr"},
  toText: () => "---",
  selectable: true
})

export const LineBreak = Leaf.defineInline("LineBreak", {
  role: Node.Role.LineBreak,
  toText: () => "\n",
  shape: {element: "br"}
})

export const Image = Leaf.Type.defineInline<string>("Image", {
  validateParam: "string",
  shape: {element: "img", attributes: src => ({src})},
  selectable: true,
  parseRules: [{
    selector: "img[src]",
    readElement: elt => (elt as HTMLImageElement).src
  }]
})

export const Figure = Leaf.Type.defineBlock<string>("Figure", {
  validateParam: "string",
  shape: {structure: src => elt("figure", elt({_: "img", src}))},
  selectable: true,
  group: G.Content,
  parseRules: [{
    selector: "figure:has(img[src])",
    readElement: elt => (elt.querySelector("img[src]") as HTMLImageElement).src,
    precedence: 2
  }]
})

export const CaptionedFigure = Plot.Type.defineBlock<string>("CaptionedFigure", {
  inlineContent: true,
  validateParam: "string",
  shape: {structure: src => elt("figure", elt({_: "img", src}), elt("figcaption", 0))},
  group: G.Content,
  parseRules: [{
    selector: "figure:has(img[src]):has(figcaption)",
    readElement: elt => (elt.querySelector("img[src]") as HTMLImageElement).src,
    contentElement: "figcaption",
    precedence: 4
  }]
})

export const ImageAlt = Mark.Type.define<string>("ImageAlt", {
  target: [Image, Figure, CaptionedFigure],
  validate: "string",
  shape: {attribute: "alt", value: 0, preferTarget: "img"}
})

export const ImageSize = Mark.Type.define<number>("ImageSize", {
  target: [Image, Figure, CaptionedFigure],
  validate: "number",
  shape: {attribute: "style", value: size => `width: ${size}px`, preferTarget: "img"}
})

export const Emphasis = Mark.define("Emphasis", {
  rank: 50,
  role: Mark.Role.Emphasis,
  shape: {element: "em"},
  parseRules: [
    {attribute: "style/font-style", value: "italic"},
    {attribute: "style/font-style", value: "normal", clearMark: p => p.name == "Emphasis"}
  ]
})

export const Strong = Mark.define("Strong", {
  rank: 60,
  role: Mark.Role.Strong,
  shape: {element: "strong"},
  parseRules: [
    {attribute: "style/font-weight",
     readAttribute: value => /^(bold(er)?|[5-9]\d{2,})$/.test(value) ? null : ParseRule.Reject},
    {attribute: "style/font-weight",
     readAttribute: value => /^(normal|lighter|[1-4]\d{2})$/.test(value) ? null : ParseRule.Reject,
     clearMark: p => p.name == "Strong"},
  ]
})

export const Underline = Mark.define("Underline", {
  rank: 40,
  role: Mark.Role.Underline,
  shape: {element: "u"},
  parseRules: [
    {attribute: "style/text-decoration", value: "underline"}
  ]
})

export const Superscript = Mark.define("Superscript", {
  rank: 45,
  shape: {element: "sup"}
})

export const Subscript = Mark.define("Subscript", {
  rank: 47,
  shape: {element: "sub"}
})

export const Link = Mark.Type.define<string>("Link", {
  rank: 20,
  validate: "string",
  shape: {
    element: "a",
    preferTarget: "a[href]",
    attributes: href => ({href}),
    read: dom => (dom as HTMLLinkElement).href
  },
})

export const Code = Mark.define("Code", {
  rank: 80,
  shape: {element: "code"}
})

export const Doc = Plot.defineDoc({
  blockContent: G.Content
})

export const basicSchema = Schema.define([
  Doc,
  Paragraph,
  Heading,
  CodeBlock,
  CodeBlockLanguage,
  Blockquote,
  Image,
  ImageAlt,
  LineBreak,
  HorizontalRule,
  BulletList,
  OrderedList,
  ListItem,
  Emphasis,
  Strong,
  Link,
  Code,
  Underline,
  Superscript,
  Subscript,
  Alignment
])
