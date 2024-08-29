import {PropType, Prop, PropSet, Emphasis, Strong, Link, Code} from "@willows/doc"
import ist from "ist"

let Tag = PropType.define<readonly number[]>("Tag", {
  rank: 10,
  set: {compare: (a, b) => a - b},
  dom: {attribute: "tag", value: ns => ns.join(" "), readAttribute: val => val.split(" ").map(n => Number(n))}
})
const tag1 = Tag.of([1]), tag2 = Tag.of([2]), tag12 = Tag.of([1, 2])

describe("Prop", () => {
  describe("eq", () => {
    it("considers identical links to be the same", () =>
       ist(Link.of("http://foo").eq(Link.of("http://foo"))))

    it("considers different links to differ", () =>
       ist(!Link.of("http://foo").eq(Link.of("http://bar"))))
  })

  describe("set-eq", () => {
    it("returns true for two empty sets", () => ist(PropSet.empty.eq(PropSet.empty)))

    it("returns true for simple identical sets", () =>
       ist(PropSet.of([Emphasis, Strong]).eq(PropSet.of([Emphasis, Strong]))))

    it("returns false for different sets", () =>
       ist(!PropSet.of([Emphasis, Strong]).eq(PropSet.of([Emphasis, Code]))))

    it("returns false when set size differs", () =>
       ist(!PropSet.of([Emphasis, Strong]).eq(PropSet.of([Emphasis, Strong, Code]))))

    it("recognizes identical links in set", () =>
       ist(PropSet.of([Link.of("http://foo"), Code]).eq(PropSet.of([Link.of("http://foo"), Code]))))

    it("recognizes different links in set", () =>
       ist(!PropSet.of([Link.of("http://foo"), Code]).eq(PropSet.of([Link.of("http://bar"), Code]))))
  })

  function eqSet(set: PropSet, array: Prop[]) {
    if (set.set.length != array.length) return false
    for (let i = 0; i < array.length; i++) if (!set.set[i].eq(array[i])) return false
    return true
  }

  describe("add", () => {
    it("can add to the empty set", () =>
       ist(PropSet.empty.add(Emphasis), [Emphasis], eqSet))

    it("is a no-op when the added thing is in set", () =>
       ist(PropSet.of([Emphasis, Emphasis]), [Emphasis], eqSet))

    it("adds marks with lower rank before others", () =>
       ist(PropSet.of([Strong, Emphasis]), [Emphasis, Strong], eqSet))

    it("adds marks with higher rank after others", () =>
       ist(PropSet.of([Strong]).add(Emphasis), [Emphasis, Strong], eqSet))

    it("replaces different marks with new params", () =>
       ist(PropSet.of([Link.of("http://foo"), Emphasis]).add(Link.of("http://bar")),
           [Link.of("http://bar"), Emphasis], eqSet))

    it("does nothing when adding an existing link", () =>
       ist(PropSet.of([Emphasis, Link.of("http://foo")]).add(Link.of("http://foo")),
           [Link.of("http://foo"), Emphasis], eqSet))

    it("puts code marks at the end", () =>
       ist(PropSet.of([Link.of("http://foo"), Emphasis, Strong]).add(Code),
           [Link.of("http://foo"), Emphasis, Strong, Code], eqSet))

    it("puts marks with middle rank in the middle", () =>
       ist(PropSet.of([Emphasis, Code]).add(Strong), [Emphasis, Strong, Code], eqSet))

    it("combines multi-props", () =>
       ist(PropSet.of([tag1]).add(tag2), [tag12], eqSet))

    it("doesn't duplicate identical instances of multi-props", () =>
       ist(PropSet.of([tag1]).add(tag1), [tag1], eqSet))
  })

  describe("remove", () => {
    it("is a no-op for the empty set", () =>
       ist(PropSet.empty.remove(Emphasis), [], eqSet))

    it("can remove the last mark from a set", () =>
       ist(PropSet.of([Emphasis]).remove(Emphasis), [], eqSet))

    it("is a no-op when the mark isn't in the set", () =>
       ist(PropSet.of([Emphasis]).remove(Strong), [Emphasis], eqSet))

    it("can remove a mark with params", () =>
       ist(PropSet.of([Link.of("http://foo")]).remove(Link.of("http://foo")), [], eqSet))

    it("doesn't remove a mark when its params differ", () =>
       ist(PropSet.of([Link.of("http://bar")]).remove(Link.of("http://foo")), [Link.of("http://bar")], eqSet))
  })
})
