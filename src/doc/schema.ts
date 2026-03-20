import {Plot, Node, Leaf} from "./node"
import {Mark} from "./mark"
import {none, validate} from "./helper"

export type SchemaElement = Leaf.Any | Plot.Tag.Any | Node.Type<any> | Mark<any> | Mark.Type<any>

// FIXME maybe don't store these forever
const schemaCache = new Set<Schema>()

export class Schema {
  private tagsByName: {[name: string]: Node.Type<unknown>} = Object.create(null)
  private marksByName: {[name: string]: Mark.Type<any>} = Object.create(null)
  private wrappingCache: {[key: string]: readonly Plot.Tag.Any[] | null} = Object.create(null)
  private validated: WeakSet<Node> = new WeakSet
  readonly docTag: Plot.Tag<null>
  /// All the schema elements that make up this schema. Useful if you
  /// want to include the schema as a whole in an editor configuration.
  elements: readonly SchemaElement[]

  private constructor(
    readonly tags: readonly Node.Type<unknown>[],
    readonly marks: readonly Mark.Type<any>[],
    docType: Plot.Type<null>,
    readonly lineBreak: Leaf<unknown> | null
  ) {
    this.docTag = docType.default!
    for (let tag of tags) this.tagsByName[tag.name] = tag
    for (let mark of marks) this.marksByName[mark.name] = mark
    this.elements = (tags as SchemaElement[]).concat(marks)
  }

  doc(children: readonly Node[]) {
    return new Plot.Doc(this, children)
  }

  validate(node: Node) {
    if (this.validated.has(node)) return
    if (node.isLeaf) {
      this.validateTag(node)
    } else {
      this.validateTag(node.tag)
      for (let ch of node.content) {
        if (!this.canContain(node.type, ch.type) || node.inlineContent != ch.isInline)
          throw new Error(`Node type ${node.name} cannot contain child ${ch.name}`)
        this.validate(ch)
      }
    }
    this.validated.add(node)
  }

  /// @internal
  validateTag(tag: Node | Plot.Tag.Any) {
    if (this.tagsByName[tag.name] != tag.type)
      throw new Error(`Tag type ${tag.name} not in schema`)
    for (let mark of tag.marks) this.validateMark(mark, tag.type)
  }

  /// @internal
  validateMark(mark: Mark<any>, node: Node.Type<any>) {
    if (this.marksByName[mark.name] != mark.type)
      throw new Error(`Mark type ${mark.name} not in schema`)
    if (!this.markAllowed(mark.type, node))
      throw new Error(`Mark type ${mark.name} cannot target node ${node.name}`)
  }

  /// Test whether a node type matches the given group query. When
  /// multiple group names, separated by spaces, are given, this
  /// tests whether the node is in _all_ of those groups.
  matchNode(node: Node.Type<any>, q: Node.Query): boolean {
    if (q instanceof Node.Group) return node.groups.has(q)
    if (q instanceof Node.Type.Base) return q == node
    if (q instanceof Node.Tag.Base) return q.type == node
    if ("and" in q) return q.and.every(q => this.matchNode(node, q))
    return (q as readonly Node.Query[]).some(q => this.matchNode(node, q))
  }

  markAllowed(mark: Mark.Type<any>, node: Node.Type<any>) {
    return this.matchNode(node, mark.target)
  }

  sharesContent(a: Plot.Type<any>, b: Plot.Type<any>) { // FIXME cache?
    for (let tp of this.tags)
      if (this.matchNode(tp, a.content) && this.matchNode(tp, b.content)) return true
    return false
  }

  addMarksFrom<T extends Node.Tag>(from: Node.Tag, to: T): T {
    if (!from.marks.length) return to
    let marks = to.marks
    for (let mark of from.marks) if (this.markAllowed(mark.type, to.type) && (mark.type.set || !mark.isInSet(marks))) {
      let {keepOnTypeChange} = mark.type.spec
      if (keepOnTypeChange && (keepOnTypeChange === true || keepOnTypeChange(from, to)))
        marks = mark.addToSet(marks)
    }
    return to.withMarks(marks) as T
  }

  canContain(parent: Plot.Type<any>, child: Node.Type<any>) {
    let result = parent.childCache.get(child)
    if (result == null) {
      result = child.isPlot && child.isDoc ? false : this.matchNode(child, parent.content)
      parent.childCache.set(child, result)
    }
    return result
  }

  // FIXME maybe have a different one for plot types
  defaultContentTag(parent: Plot.Type<any>): Node.Tag | null {
    for (let tag of this.tags) if (tag.default && this.canContain(parent, tag)) return tag.default
    return null
  }

  defaultContentPlot(parent: Plot.Type<any>): Plot.Tag.Any | null {
    for (let tag of this.tags) if (tag.default && tag.isPlot && this.canContain(parent, tag)) return tag.default
    return null
  }

  createDefault(parent: Plot.Type<any>): Node {
    let child = this.defaultContentTag(parent)
    if (!child) throw new Error(`No defaultable child node for ${parent.name}`)
    if (child.isLeaf) return child
    return child.create(child.inlineContent ? [] : [this.createDefault(child.type)])
  }

  findWrapping(parent: Plot.Type<any>, child: Node.Type<any>): readonly Plot.Tag.Any[] | null {
    let key = `${parent.name}-${child.name}`, cached = this.wrappingCache[key]
    if (cached !== undefined) return cached
    return this.wrappingCache[key] = this.findWrappingInner(parent, child)
  }

  private findWrappingInner(parent: Plot.Type<any>, child: Node.Type<any>): readonly Plot.Tag.Any[] | null {
    let seen: Set<Node.Type<unknown>> = new Set, work: Plot.Tag.Any[][] = [[]]
    for (let i = 0; i < work.length; i++) {
      let path = work[i], at = path.length ? path[path.length - 1].type : parent
      for (let tag of this.tags) if (this.canContain(at, tag)) {
        if (tag == child) return path
        if (!seen.has(tag) && !tag.isLeaf && tag.default) {
          seen.add(tag)
          work.push(path.concat(tag.default))
        }
      }
    }
    return null
  }

  getMark(name: string): Mark.Type<any> | undefined { return this.marksByName[name] }

  static define(spec: readonly SchemaElement[]) {
    for (let cached of schemaCache)
      if (cached.elements.length == spec.length && cached.elements.every((e, i) => e == spec[i]))
        return cached

    let tags: Node.Type<any>[] = [Leaf.Text], marks: Mark.Type<unknown>[] = []
    let defaultI = 0
    let tagNames: Set<string> = new Set, markNames: Set<string> = new Set
    for (let elt of spec) {
      if (elt instanceof Plot.Tag || elt instanceof Leaf || elt instanceof Mark) elt = elt.type
      if (elt instanceof Plot.Type || elt instanceof Leaf.Type) {
        if (tags.includes(elt)) continue
        if (tagNames.has(elt.name)) throw new Error(`Duplicate use of tag name ${elt.name} in schema`)
        tagNames.add(elt.name)
        if (elt.isPlot && elt.spec.defaultBlock) tags.splice(defaultI++, 0, elt)
        else tags.push(elt)
      } else if (elt instanceof Mark.Type) {
        if (marks.includes(elt)) continue
        if (markNames.has(elt.name)) throw new Error(`Duplicate use of mark name ${elt.name} in schema`)
        markNames.add(elt.name)
        marks.push(elt as any)
      } else {
        throw new Error("Unexpected schema element type. You may have multiple versions of @wordgard/doc loaded")
      }
    }
    let docTag: Plot.Type<null> | null = null
    let lineBreak: Leaf<any> | null = null
    for (let tag of tags) {
      if (tag.isLeaf) {
        if (tag.hasRole(Node.Role.LineBreak)) {
          if (tag.isBlock || !tag.default)
            throw new Error("Line break tags must be inline leaves with a default param")
          if (lineBreak) throw new Error("Multiple line break tags provided")
          lineBreak = tag.default
        }
      } else {
        if (tag.isDoc) {
          if (docTag) throw new Error("Multiple document tags specified")
          docTag = tag
        }
      }
    }
    if (!docTag) throw new Error("A schema must define a document tag")
    let schema = new Schema(tags, marks, docTag, lineBreak as Leaf<unknown> | null)
    for (let tag of tags) if (tag.isPlot) {
      let sawDefaultable = false
      for (let child of tags) if (schema.canContain(tag, child)) {
        if (child.default) sawDefaultable = true
        if (child.isInline != tag.inlineContent)
          throw new Error(`Node type ${tag.name} has ${tag.inlineContent ? "block" : "inline"
                            } content, but allows ${child.name} as a child`)
      }
      if (!tag.inlineContent && !sawDefaultable)
        throw new Error(`Node ${tag.name} has block content, but all possible children require non-default parameters`)
    }
    schemaCache.add(schema)
    return schema
  }

  append(other: Schema | readonly SchemaElement[]) {
    let add: SchemaElement[] = []
    for (let elt of (other instanceof Schema ? other.elements : other)) {
      if (elt instanceof Leaf || elt instanceof Plot.Tag || elt instanceof Mark) elt = elt.type
      if ((elt instanceof Mark.Type ? this.marksByName : this.tagsByName)[elt.name] != elt) add.push(elt)
    }
    return add.length ? Schema.define(this.elements.concat(add)) : this
  }

  nodeFromJSON(json: Node.JSON): Node {
    let tag = this.tagFromJSON(json), children = none
    if (tag.isLeaf) return tag
    if (json.content && Array.isArray(json.content))
      children = json.content.map(c => this.nodeFromJSON(c))
    if (tag.type.isDoc) return this.doc(children)
    return tag.create(children)
  }

  tagFromJSON(json: Node.JSON) {
    if (!json || typeof json != "object" || !(json.type in this.tagsByName))
      throw new Error("Invalid tag JSON")
    let type = this.tagsByName[json.type]
    let marks = json.marks ? this.marksFromJSON(json.marks) : none
    let tag = "param" in json ? type.of(validate(type.spec.validateParam, json.param), marks)
      : !type.default ? null
      : marks.length ? type.of(type.default.param, marks) : type.default
    if (!tag) throw new Error(`Missing param for tag type ${type.name}`)
    return tag
  }

  marksFromJSON(json: Record<string, any>): readonly Mark<undefined>[] {
    if (!json || typeof json != "object") throw new Error("Invalid mark JSON")
    let marks = none
    for (let name in json) {
      let mark = this.marksByName[name]
      if (!mark) throw new Error(`Unrecognized mark ${name} in JSON`)
      marks = mark.of(validate(mark.spec.validate, json[name])).addToSet(marks)
    }
    return marks
  }

  docFromJSON(json: Node.JSON) {
    if (!json || json.type != this.docTag.name)
      throw new Error("Invalid document JSON")
    return this.nodeFromJSON(json) as Plot.Doc
  }
}
