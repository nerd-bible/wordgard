import {elt, Reject, Plot, Leaf, Mark, Schema} from "wordgard/doc"

export const Paragraph = Plot.defineBlock("Paragraph", {
  inlineContent: true,
  group: "Block",
  defaultBlock: true,
  shape: {element: "p"}
})

export const Heading = Plot.Type.defineBlock("Heading", {
  defaultParam: 1,
  validateParam: "number",
  inlineContent: true,
  group: "Block",
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
  group: ["Block", "Code"],
  shape: {element: "pre"},
})

export const CodeBlockLanguage = Mark.Type.define("CodeBlockLanguage", {
  tags: "CodeBlock",
  validate: "string",
  shape: {attribute: "data-language", readAttribute: x => x}
})

export const Blockquote = Plot.defineBlock("Blockquote", {
  blockContent: "Block",
  group: "Block",
  shape: {element: "blockquote"},
  autoJoin: true
})

export const OrderedList = Plot.Type.defineBlock("OrderedList", {
  defaultParam: 1,
  validateParam: "number",
  blockContent: "ListItem",
  group: ["Block", "List.Ordered"],
  shape: {
    element: "ol",
    attributes: order => order == 1 ? {} as Record<string, string> : {order: String(order)},
    readElement: elt => Number(elt.getAttribute("order") || "1")
  },
  autoJoin: (_a, b) => b.param == 1
})

export const BulletList = Plot.defineBlock("BulletList", {
  blockContent: "ListItem",
  group: ["Block", "List.Bullet"],
  shape: {element: "ul"},
  autoJoin: true
})

export const ListItem = Plot.defineBlock("ListItem", {
  blockContent: "Block",
  shape: {element: "li"},
  defining: true,
})

export const HorizontalRule = Leaf.defineBlock("HorizontalRule", {
  group: "Block",
  shape: {element: "hr"},
  toText: () => "---"
})

export const Image = Leaf.Type.defineInline<string>("Image", {
  validateParam: "string",
  shape: {element: "img", attributes: src => ({src}), readElement: elt => (elt as HTMLImageElement).src || Reject}
})

export const ImageAlt = Mark.Type.define<string>("ImageAlt", {
  tags: "Image",
  validate: "string",
  shape: {attribute: "alt", readAttribute: x => x}
})

export const LineBreak = Leaf.defineInline("LineBreak", {
  group: "LineBreak",
  toText: () => "\n",
  shape: {element: "br"}
})

export const Emphasis = Mark.define("Emphasis", {
  rank: 50,
  group: "Emphasis",
  shape: {element: "em"},
  parseRules: [
    {attribute: "style/font-style", value: "italic"},
    {attribute: "style/font-style", value: "normal", clearMark: p => p.name == "Emphasis"}
  ]
})

export const Strong = Mark.define("Strong", {
  rank: 60,
  group: "Strong",
  shape: {element: "strong"},
  parseRules: [
    {attribute: "style/font-weight",
     readAttribute: value => /^(bold(er)?|[5-9]\d{2,})$/.test(value) ? null : Reject},
    {attribute: "style/font-weight",
     readAttribute: value => /^(normal|lighter|[1-4]\d{2})$/.test(value) ? null : Reject,
     clearMark: p => p.name == "Strong"},
  ]
})

export const Underline = Mark.define("Underline", {
  rank: 40,
  group: "Underline",
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
    selector: "a[href]",
    attributes: href => ({href}),
    readElement: dom => (dom as HTMLLinkElement).href
  },
})

export const Code = Mark.define("Code", {
  rank: 80,
  shape: {element: "code"}
})

export const Doc = Plot.defineDoc({
  blockContent: "Block"
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
  Subscript
])
