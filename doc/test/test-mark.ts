import {Mark, MarkType, Emphasis, Strong, Link, Code} from "@willow/doc"
import ist from "ist"

const em = Emphasis.create()
const strong = Strong.create()
const link = (href: string) => Link.create({href})
const code = Code.create()

let Tag = MarkType.define<{id: number}>("Tag", {
  rank: 10,
  attrs: {
    id: {attribute: "id"}
  },
  tag: "span",
  excludes: ""
})
const tag1 = Tag.create({id: 1}), tag2 = Tag.create({id: 2})

let Exclusive = MarkType.define("Exclusive", {
  attrs: {at: {default: 3, attribute: "at"}},
  rank: 20,
  tag: "var",
  excludes: "_"
})
let excl = Exclusive.create(), excl2 = Exclusive.create({at: 2})

describe("Mark", () => {
  describe("eq", () => {
    it("considers identical links to be the same", () =>
       ist(link("http://foo").eq(link("http://foo"))))

    it("considers different links to differ", () =>
       ist(!link("http://foo").eq(link("http://bar"))))
  })

  describe("sameSet", () => {
    it("returns true for two empty sets", () => ist(Mark.sameSet([], [])))

    it("returns true for simple identical sets", () =>
       ist(Mark.sameSet([em, strong], [em, strong])))

    it("returns false for different sets", () =>
       ist(!Mark.sameSet([em, strong], [em, code])))

    it("returns false when set size differs", () =>
       ist(!Mark.sameSet([em, strong], [em, strong, code])))

    it("recognizes identical links in set", () =>
       ist(Mark.sameSet([link("http://foo"), code], [link("http://foo"), code])))

    it("recognizes different links in set", () =>
       ist(!Mark.sameSet([link("http://foo"), code], [link("http://bar"), code])))
  })

  describe("addToSet", () => {
    it("can add to the empty set", () =>
       ist(em.addToSet([]), [em], Mark.sameSet))

    it("is a no-op when the added thing is in set", () =>
       ist(em.addToSet([em]), [em], Mark.sameSet))

    it("adds marks with lower rank before others", () =>
       ist(em.addToSet([strong]), [em, strong], Mark.sameSet))

    it("adds marks with higher rank after others", () =>
       ist(strong.addToSet([em]), [em, strong], Mark.sameSet))

    it("replaces different marks with new attributes", () =>
       ist(link("http://bar").addToSet([link("http://foo"), em]),
           [link("http://bar"), em], Mark.sameSet))

    it("does nothing when adding an existing link", () =>
       ist(link("http://foo").addToSet([em, link("http://foo")]),
           [em, link("http://foo")], Mark.sameSet))

    it("puts code marks at the end", () =>
       ist(code.addToSet([em, strong, link("http://foo")]),
           [em, strong, link("http://foo"), code], Mark.sameSet))

    it("puts marks with middle rank in the middle", () =>
       ist(strong.addToSet([em, code]), [em, strong, code], Mark.sameSet))

    it("allows nonexclusive instances of marks with the same type", () =>
       ist(tag2.addToSet([tag1]), [tag2, tag1], Mark.sameSet))

    it("doesn't duplicate identical instances of nonexclusive marks", () =>
       ist(tag1.addToSet([tag1]), [tag1], Mark.sameSet))

    it("clears all others when adding a globally-excluding mark", () =>
       ist(excl.addToSet([tag1, em]), [excl], Mark.sameSet))

    it("does not allow adding another mark to a globally-excluding mark", () =>
       ist(em.addToSet([excl]), [excl], Mark.sameSet))

    it("does overwrite a globally-excluding mark when adding another instance", () =>
       ist(excl2.addToSet([excl]), [excl2], Mark.sameSet))
  })

  describe("removeFromSet", () => {
    it("is a no-op for the empty set", () =>
       ist(Mark.sameSet(em.removeFromSet([]), [])))

    it("can remove the last mark from a set", () =>
       ist(Mark.sameSet(em.removeFromSet([em]), [])))

    it("is a no-op when the mark isn't in the set", () =>
       ist(Mark.sameSet(strong.removeFromSet([em]), [em])))

    it("can remove a mark with attributes", () =>
       ist(Mark.sameSet(link("http://foo").removeFromSet([link("http://foo")]), [])))

    it("doesn't remove a mark when its attrs differ", () =>
       ist(link("http://foo").removeFromSet([link("http://bar")]),
           [link("http://bar")], Mark.sameSet))
  })
})
