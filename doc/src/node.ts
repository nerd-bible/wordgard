export class Node {
  constructor(
    readonly name: NodeName,
    readonly attrs: readonly Attr[],
    readonly children: readonly Node[],
  ) {}

  static define(name: string, spec: NodeSpec) {
    return new NodeName(name, ++nextID, spec)
  }
}

export class Attr<T = any> {
  constructor(
    readonly name: AttrName<T>,
    readonly value: T
  ) {}

  static define(name: string, spec: AttrSpec) {
    return new AttrName(name, ++nextID, spec)
  }
}

export type NodeSpec = {
  content?: readonly (NodeName | string)[],
  attrs?: readonly AttrName[],
  group?: string,
}

let nextID = 0

export class NodeName {
  attrs: readonly AttrName[]
  content: readonly NodeName[] = []
  schemaElement: SchemaElement

  constructor(readonly name: string, readonly id: number, readonly spec: NodeSpec) {
    this.attrs = spec.attrs || []
    this.schemaElement = this
  }

  configure(spec: NodeSpec) {
    return new NodeName(this.name, this.id, {...this.spec, ...spec})
  }

  hasGroup(group: string) {
    return this.spec.group && this.spec.group.split(" ").includes(group)
  }
}

export type AttrSpec = {
}

export class AttrName<T = any> {
  constructor(readonly name: string, readonly id: number, spec: AttrSpec) {}

  of(value: T) { return new Attr(this, value) }

  addToNodes(nodes: readonly NodeName[] | ((node: NodeName) => boolean)): SchemaElement {
    return new AttrAdder(this, nodes)
  }
}

class AttrAdder {
  schemaElement!: SchemaElement

  constructor(
    readonly attr: AttrName,
    readonly nodes: readonly NodeName[] | ((node: NodeName) => boolean)
  ) {}
}

export type SchemaElement = {schemaElement: SchemaElement} | readonly SchemaElement[]

export class Schema {
  private constructor(
    nodes: {[id: number]: NodeName}
  ) {}

  define(spec: SchemaElement) {
    let nodes: NodeName[] = [], extraAttrs: AttrAdder[] = []
    function scan(spec: SchemaElement) {
      if (Array.isArray(spec)) {
        spec.forEach(scan)
      } else if (spec instanceof NodeName) {
        if (nodes.some(n => n.name == spec.name))
          throw new Error(`Duplicate use of node name ${spec.name} in schema`)
        nodes.push(spec)
      } else if (spec instanceof AttrAdder) {
        extraAttrs.push(spec)
      } else {
        scan((spec as any).schemaElement)
      }
    }
    scan(spec)
    let byID = Object.create(null)
    for (let node of nodes) {
      let {attrs} = node
      for (let add of extraAttrs) {
        if (Array.isArray(add.nodes) ? add.nodes.some(n => n.id == node.id) : (add as any).nodes(node)) {
          if (!attrs.some(a => a.id == add.attr.id)) {
            if (attrs.some(a => a.name == add.attr.name))
              throw new Error(`Duplicate use of attribute name ${add.attr.name} in node ${node.name}`)
            attrs = attrs.concat(add.attr)
          }
        }
      }
      node = node.configure({attrs})
      byID[node.id] = node
    }
    for (let node of nodes) {
      let content: NodeName[] = []
      if (node.spec.content) for (let spec of node.spec.content) {
        let set = typeof spec == "string" ? nodes.filter(n => n.hasGroup(spec)) : [spec]
        for (let name of set) {
          if (!content.some(n => n.id == name.id)) content.push(byID[name.id])
        }
      }
      byID[node.id].content = content
    }
    return new Schema(byID)
  }
}
