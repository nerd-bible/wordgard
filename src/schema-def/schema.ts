import {elt, ParseRule, Plot, Leaf, Node, Mark, ValidationError} from "wordgard/doc"

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

export const InlineListItem = Plot.defineBlock("ListItem", {
  inlineContent: true,
  shape: {element: "li"},
  defining: true,
})

export const OrderedList = Plot.Type.defineBlock("OrderedList", {
  defaultParam: 1,
  validateParam: "number",
  blockContent: [ListItem, InlineListItem],
  group: G.Content,
  role: Node.Role.List,
  defining: true,
  shape: {
    element: "ol",
    attributes: start => start == 1 ? {} as Record<string, string> : {start: String(start)},
    read: elt => Number(elt.getAttribute("start") || "1")
  },
  autoJoin: (_a, b) => b.param == 1
})

export const BulletList = Plot.defineBlock("BulletList", {
  blockContent: [ListItem, InlineListItem],
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

export const Cell = Plot.defineBlock("Cell", {
  inlineContent: true,
  group: G.TableCell,
  isolating: true,
  cursorBarrier: false,
  shape: {element: "td"}
})

export const HeaderCell = Plot.defineBlock("HeaderCell", {
  inlineContent: true,
  group: G.TableCell,
  isolating: true,
  cursorBarrier: false,
  shape: {element: "th"}
})

export const BlockCell = Plot.defineBlock("Cell", {
  blockContent: G.Content,
  group: G.TableCell,
  isolating: true,
  cursorBarrier: false,
  shape: {element: "td"}
})

export const BlockHeaderCell = Plot.defineBlock("HeaderCell", {
  blockContent: G.Content,
  group: G.TableCell,
  isolating: true,
  cursorBarrier: false,
  shape: {element: "th"}
})

export const TableRow = Plot.defineBlock("TableRow", {
  blockContent: G.TableCell,
  canBeEmpty: true,
  orientation: "row",
  shape: {element: "tr"}
})

export const Table = Plot.defineBlock("Table", {
  blockContent: TableRow,
  isolating: true,
  group: G.Content,
  shape: {structure: elt("table", elt("tbody", 0))},
  parseRules: [{selector: "table"}]
})

function validatePosInt(value: any) {
  if (typeof value != "number" || Math.round(value) != value || value < 1)
    throw new RangeError(`${value} is not a positive integer`)
}

function readPosInt(value: string) {
  let num = Number.parseInt(value)
  if (Number.isNaN(num) || num < 1) return ParseRule.Reject
  return num
}

export const ColSpan = Mark.Type.define<number>("ColSpan", {
  target: G.TableCell,
  validate: validatePosInt,
  shape: {attribute: "colspan", value: span => String(span), readAttribute: readPosInt}
})

export const RowSpan = Mark.Type.define<number>("RowSpan", {
  target: G.TableCell,
  validate: validatePosInt,
  shape: {attribute: "rowspan", value: span => String(span), readAttribute: readPosInt}
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
    marksFrom: "img[src]",
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
    marksFrom: "img[src]",
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

export const Alignment = Mark.Type.define<"end" | "center">("Alignment", {
  role: Mark.Role.Alignment,
  target: [G.Textblock, Figure, CaptionedFigure],
  keepOnSplit: true,
  keepOnTypeChange: true,
  shape: {attribute: "style", value: align => `text-align: ${align}`},
  parseRules: [
    {attribute: "style/text-align", readAttribute: value => /^(end|center)$/.test(value) ? value as any : ParseRule.Reject}
  ]
})

export const Direction = Mark.Type.define<"ltr" | "rtl" | "auto">("Direction", {
  role: Mark.Role.Direction,
  target: G.Textblock,
  keepOnSplit: true,
  keepOnTypeChange: true,
  validate: val => {
    if (val != "ltr" && val != "rtl" && val != "auto") throw new ValidationError(`Invalid direction value: ${val}`)
  },
  shape: {attribute: "dir", value: 0}
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
  inclusive: false,
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

export const Color = Mark.Type.define<string>("Color", {
  rank: 30,
  shape: {attribute: "style/color", value: 0},
  spanning: true,
})

export const BackgroundColor = Mark.Type.define<string>("BackgroundColor", {
  rank: 35,
  shape: {attribute: "style/background-color", value: 0},
  spanning: true,
})

// FIXME rename BlockDoc? Provide InlineDoc?
export const Doc = Plot.defineDoc({
  blockContent: G.Content
})
