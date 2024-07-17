import ist from "ist"
import {Node, NodeType, basicBuilder, tag, Paragraph, Image, basicSchema as schema} from "@willows/doc"
const {doc, blockquote, p, li, ul, hr, em, strong, code, $img, $a} = basicBuilder

describe("Node", () => {
  describe("toString", () => {
    it("nests", () => {
      ist(doc(ul(li(p("hey"), p()), li(p("foo")))).toString(),
          'Doc(BulletList(ListItem(Paragraph("hey"),Paragraph()),ListItem(Paragraph("foo"))))')
    })

    it("shows inline children", () => {
      ist(doc(p("foo", $img(), "bar")).toString(),
          'Doc(Paragraph("foo",Image,"bar"))')
    })

    it("shows marks", () => {
      ist(doc(p("foo", em("bar", strong("quux")), code("baz"))).toString(),
          'Doc(Paragraph("foo",Emphasis("bar"),Emphasis(Strong("quux")),Code("baz")))')
    })
  })

  describe("iterate", () => {
    function iterate(doc: Node, ...nodes: string[]) {
      let i = 0
      doc.iterate(tag(doc, 1), tag(doc, 2), (node, pos) => {
        if (i == nodes.length)
          throw new Error("More nodes iterated than listed (" + node.type.name + ")")
        let compare = node.isText() ? node.text : node.type.name
        if (compare != nodes[i++])
          throw new Error("Expected " + JSON.stringify(nodes[i - 1]) + ", got " + JSON.stringify(compare))
        if (!node.isText && doc.nodeAt(pos) != node)
          throw new Error("Pos " + pos + " does not point at node " + node + " " + doc.nodeAt(pos))
      })
    }

    it("iterates over text", () =>
       iterate(doc(p("foo", 1, "bar", 2, "baz")),
               "Doc", "Paragraph", "foobarbaz"))

    it("descends multiple levels", () =>
       iterate(doc(blockquote(ul(li(p("f", 1, "oo"))), p("b"), 2), p("c")),
               "Doc", "Blockquote", "BulletList", "ListItem", "Paragraph", "foo", "Paragraph", "b"))

    it("iterates over inline nodes", () =>
       iterate(doc(p(em("x"), "f", 1, "oo", em("bar", $img(), strong("baz")), "quux", code("xy", 2, "z"))),
               "Doc", "Paragraph", "foo", "bar", "Image", "baz", "quux", "xyz"))
  })

  describe("textContent", () => {
    it("works with leafText", () => {
      const d = doc(p("foo", $img()))
      ist(d.textContent({leafText: "[LEAF]"}), 'foo[LEAF]')
      ist(d.textContent({leafText: (node) => "[LEAF]"}), 'foo[LEAF]')
    })

    it("adds block separator around empty paragraphs", () => {
      ist(doc(p("one"), p(), p("two")).textContent({blockSeparator: "\n\n"}), "one\n\n\n\ntwo")
    })

    it("adds block separator around leaf nodes", () => {
      ist(doc(p("one"), hr(), hr(), p("two")).textContent(), "one\n---\n---\ntwo")
    })

    let BlockLeaf = NodeType.block("BlockLeaf", {group: "Block", dom: {tag: "div"}})

    it("doesn't add block separator around non-rendered leaf nodes", () => {
      ist(blockquote(p("one"), BlockLeaf.create(), BlockLeaf.create(), p("two")).textContent(), "one\ntwo")
    })

    it("can take partial content", () => {
      ist(doc(p("one"), p("two")).textContent({from: 2, to: 8}), "ne\ntw")
    })

    it("doesn't get confused by leading wrapper blocks", () => {
      ist(doc(blockquote(p("a"))).textContent(), "a")
    })
  })

  describe("create", () => {
    it("fills params", () => {
      let i = Image.createWith({src: "x.jpg"})
      ist(i.prop(Image.props.src), "x.jpg")
      ist(i.prop(Image.props.alt), undefined)
    })

    it("complains about missing params", () => {
      ist.throws(() => Image.createWith({}), /Required prop/)
    })

    it("allows child nodes", () => {
      ist(Paragraph.create([Node.text("a")]), p("a"), eq)
    })

    it("disallows incorrect child nodes", () => {
      ist.throws(() => Paragraph.create([Paragraph.create()]), /not a valid child/)
    })
  })

  describe("toJSON", () => {
    function roundTrip(doc: Node) {
      ist(schema.nodeFromJSON(doc.toJSON()), doc, eq)
    }

    it("can serialize a simple node", () => roundTrip(doc(p("foo"))))

    it("can serialize marks", () =>
       roundTrip(doc(p("foo", em("bar", strong("baz")), " ", $a("x")))))

    it("can serialize inline leaf nodes", () =>
       roundTrip(doc(p("foo", em($img(), "bar")))))

    it("can serialize block leaf nodes", () =>
       roundTrip(doc(p("a"), hr(), p("b"), p())))

    it("can serialize nested nodes", () =>
       roundTrip(doc(blockquote(ul(li(p("a"), p("b")), li(p($img()))), p("c")), p("d"))))
  })
})

function eq<T extends {eq(b: T): boolean}>(a: T, b: T) { return a.eq(b) }
