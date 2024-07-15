import {Prop, PropValue, PropSet, Emphasis, Strong, Link, Code} from "@willows/doc"
import ist from "ist"

const em = Emphasis
const strong = Strong
const link = (href: string) => Link.of({href})
const code = Code

let Tag = Prop.define<readonly number[]>("Tag", {
  rank: 10,
  multi: {compare: (a, b) => a - b},
})
const tag1 = Tag.of([1]), tag2 = Tag.of([2]), tag12 = Tag.of([1, 2])

describe("Prop", () => {
  describe("eq", () => {
    it("considers identical links to be the same", () =>
       ist(link("http://foo").eq(link("http://foo"))))

    it("considers different links to differ", () =>
       ist(!link("http://foo").eq(link("http://bar"))))
  })

  describe("set-eq", () => {
    it("returns true for two empty sets", () => ist(PropSet.empty.eq(PropSet.empty)))

    it("returns true for simple identical sets", () =>
       ist(PropSet.of([em, strong]).eq(PropSet.of([em, strong]))))

    it("returns false for different sets", () =>
       ist(!PropSet.of([em, strong]).eq(PropSet.of([em, code]))))

    it("returns false when set size differs", () =>
       ist(!PropSet.of([em, strong]).eq(PropSet.of([em, strong, code]))))

    it("recognizes identical links in set", () =>
       ist(PropSet.of([link("http://foo"), code]).eq(PropSet.of([link("http://foo"), code]))))

    it("recognizes different links in set", () =>
       ist(!PropSet.of([link("http://foo"), code]).eq(PropSet.of([link("http://bar"), code]))))
  })

  function eqSet(set: PropSet, array: PropValue[]) {
    if (set.set.length != array.length) return false
    for (let i = 0; i < array.length; i++) if (!set.set[i].eq(array[i])) return false
    return true
  }

  describe("add", () => {
    it("can add to the empty set", () =>
       ist(PropSet.empty.add(em), [em], eqSet))

    it("is a no-op when the added thing is in set", () =>
       ist(PropSet.of([em, em]), [em], eqSet))

    it("adds marks with lower rank before others", () =>
       ist(PropSet.of([strong, em]), [em, strong], eqSet))

    it("adds marks with higher rank after others", () =>
       ist(PropSet.of([strong]).add(em), [em, strong], eqSet))

    it("replaces different marks with new params", () =>
       ist(PropSet.of([link("http://foo"), em]).add(link("http://bar")),
           [link("http://bar"), em], eqSet))

    it("does nothing when adding an existing link", () =>
       ist(PropSet.of([em, link("http://foo")]).add(link("http://foo")),
           [link("http://foo"), em], eqSet))

    it("puts code marks at the end", () =>
       ist(PropSet.of([link("http://foo"), em, strong]).add(code),
           [link("http://foo"), em, strong, code], eqSet))

    it("puts marks with middle rank in the middle", () =>
       ist(PropSet.of([em, code]).add(strong), [em, strong, code], eqSet))

    it("combines multi-props", () =>
       ist(PropSet.of([tag1]).add(tag2), [tag12], eqSet))

    it("doesn't duplicate identical instances of multi-props", () =>
       ist(PropSet.of([tag1]).add(tag1), [tag1], eqSet))
  })

  describe("remove", () => {
    it("is a no-op for the empty set", () =>
       ist(PropSet.empty.remove(em), [], eqSet))

    it("can remove the last mark from a set", () =>
       ist(PropSet.of([em]).remove(em), [], eqSet))

    it("is a no-op when the mark isn't in the set", () =>
       ist(PropSet.of([em]).remove(strong), [em], eqSet))

    it("can remove a mark with params", () =>
       ist(PropSet.of([link("http://foo")]).remove(link("http://foo")), [], eqSet))

    it("doesn't remove a mark when its params differ", () =>
       ist(PropSet.of([link("http://bar")]).remove(link("http://foo")), [link("http://bar")], eqSet))
  })
})
