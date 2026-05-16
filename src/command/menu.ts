import {type Wordgard} from "wordgard/editor"
import {Command} from "wordgard/command"
import {GardState, Transaction, Facet, PhraseSet} from "wordgard/state"
import {phrases} from "wordgard/phrases"

export namespace Menu {
  export type Label = PhraseSet.Ref | {icon: string, directional?: boolean} | Menu.LabelWidget

  export type LabelWidget = {
    render: (wg: Wordgard) => HTMLElement
    rerender?: (tr: Transaction) => boolean
    update?: (elt: HTMLElement, wg: Wordgard) => void
  }

  export type Item = Menu.Button | Menu.CustomControl | Menu.Submenu | Menu.Group

  export namespace Item {
    export interface Spec {
      select?: (state: GardState) => boolean
      enable?: (state: GardState) => boolean
      /// By default, state predicates (`select`, `enable`, and `active`)
      /// are re-checked whenever the document or selection changes. If an
      /// item is sensitive to other aspects of the state, provide a test
      /// here that returns `true` for transactions that might affect the
      /// item state.
      updateFor?: (tr: Transaction) => boolean
      parent?: Menu.Group | Menu.Submenu
      rank?: number
      description?: PhraseSet.Ref
    }

    export class Base {
      select: ((state: GardState) => boolean) | undefined
      enable: ((state: GardState) => boolean) | undefined
      updateFor: ((tr: Transaction) => boolean) | undefined
      parent: Menu.Group | Menu.Submenu | undefined
      rank: number
      description: PhraseSet.Ref | undefined

      constructor(spec: Menu.Item.Spec) {
        this.select = spec.select
        this.enable = spec.enable
        this.updateFor = spec.updateFor
        this.parent = spec.parent
        this.rank = spec.rank ?? 100
        this.description = spec.description
      }
    }

    export const source = Facet.define<Menu.Item>()
  }

  // FIXME make it easier to modify these
  export class Button extends Menu.Item.Base {
    label: Menu.Label
    run: Command.Bound | Command
    active: ((state: GardState) => boolean) | undefined
    extension: GardState.Extension

    constructor(spec: {
      run: Command.Bound | Command
      active?: (state: GardState) => boolean
      label: Menu.Label
    } & Menu.Item.Spec) {
      super(spec)
      this.run = spec.run
      this.active = spec.active
      this.label = spec.label
      this.extension = Menu.Item.source.of(this)
      if (this.parent) this.extension = [this.parent.extension, this.extension]
    }
  }

  export class CustomControl extends Menu.Item.Base {
    render: (wg: Wordgard, done: () => void) => {dom: HTMLElement, focus?: HTMLElement}
    setEnabled: ((dom: Element, enabled: boolean) => void) | undefined
    extension: GardState.Extension

    constructor(spec: {
      render: (wg: Wordgard, done: () => void) => {dom: HTMLElement, focus?: HTMLElement}
      setEnabled?: (focus: Element, enabled: boolean) => void
    } & Menu.Item.Spec) {
      super(spec)
      this.render = spec.render
      this.setEnabled = spec.setEnabled
      this.extension = Menu.Item.source.of(this)
    }
  }

  export class Submenu extends Menu.Item.Base {
    label: Menu.Label | undefined
    defaultLabel: Menu.Label | undefined
    arrow: boolean
    width: number | undefined
    content: readonly (Menu.Item | "...")[] | undefined
    extension: GardState.Extension

    constructor(spec: {
      label?: Menu.Label
      defaultLabel?: Menu.Label
      arrow?: boolean
      width?: number,
      content?: readonly (Menu.Item | "...")[]
    } & Menu.Item.Spec) {
      super(spec)
      this.label = spec.label
      this.defaultLabel = spec.defaultLabel
      this.arrow = spec.arrow !== false
      this.width = spec.width
      this.content = spec.content
      this.extension = Menu.Item.source.of(this)
    }

    template(...content: (Menu.Template | Menu.Item | "...")[]) {
      return new Menu.Template(this, content.length ? content : ["..."])
    }
  }

  export namespace Submenu {
    export class Resolved {
      constructor(readonly item: Menu.Submenu, readonly content: readonly Menu.ResolvedItem[]) {}
    }
  }

  export class Group {
    margin: boolean
    extension: GardState.Extension
    parent: Menu.Group | Menu.Submenu | undefined
    rank: number
    content: readonly (Menu.Item | "...")[] | undefined

    constructor(spec: {
      margin?: boolean
      parent?: Menu.Group | Menu.Submenu
      rank?: number,
      content?: readonly (Menu.Item | "...")[]
    } = {}) {
      this.margin = !!spec.margin
      this.extension = Menu.Item.source.of(this)
      this.parent = spec.parent
      this.rank = spec.rank ?? 100
      this.content = spec.content
    }

    template(...content: (Menu.Template | Menu.Item | "...")[]) {
      return new Menu.Template(this, content.length ? content : ["..."])
    }
  }

  export class Template {
    parent: Menu.Group | Menu.Submenu | null
    rank: number

    constructor(readonly item: Menu.Group | Menu.Submenu, readonly content: readonly (Menu.Template | Menu.Item | "...")[] = []) {
      this.parent = item.parent ?? null
      this.rank = item.rank ?? 100
    }
  }

  // FIXME lowercase, move inline mark menu back here
  export const Top = new Menu.Group()
  export const Commands = new Menu.Group({parent: Menu.Top, rank: 10})
  export const BlockMenu = new Menu.Group({parent: Menu.Top, rank: 50, margin: true})

  export const TextblockStyle = new Menu.Submenu({
    defaultLabel: phrases.ref("block_style"),
    description: phrases.ref("block_style"),
    parent: Menu.Top,
    rank: 5,
    width: 10,
  })

  export type ResolvedItem = Menu.Button | Menu.CustomControl | "|" | Menu.Submenu.Resolved

  export function resolve(
    items: readonly Menu.Item[],
    template: Menu.Template | readonly Menu.Template[] = Menu.Top.template(),
    suppress?: readonly Menu.Item[]
  ): readonly Menu.ResolvedItem[] {
    // 1 means not used yet, but will be used in template, so ignore
    // when filling items, 2 means used/suppressed
    let used = new Map<Menu.Item, number>()
    if (suppress) for (let item of suppress) used.set(item, 2)
    function scan(template: Menu.Template) {
      used.set(template.item, 1)
      for (let child of template.content) {
        if (child instanceof Menu.Template) scan(child)
        else if (typeof child != "string") used.set(child, 1)
      }
    }
    function margin(target: Menu.ResolvedItem[]) {
      if (target.length && target[target.length - 1] !== "|") target.push("|")
    }
    function resolve(template: Menu.Item | Menu.Template,
                     content: readonly (Menu.Template | Menu.Item | "...")[] | null,
                     target: Menu.ResolvedItem[],
                     fromTemplate: boolean) {
      if (template instanceof Menu.Template) {
        resolve(template.item, template.content, target, true)
      } else {
        let wasUsed = used.get(template)
        if (fromTemplate ? wasUsed == 2 : wasUsed != null) return
        used.set(template, 2)
        if (template instanceof Menu.Submenu || template instanceof Menu.Group) {
          if (template instanceof Menu.Group && template.margin) margin(target)
          let innerTarget: Menu.ResolvedItem[] = template instanceof Menu.Submenu ? [] : target
          for (let elt of content || template.content || ["..."]) {
            if (elt === "...") {
              let found: Menu.Item[] = items.filter(i => i.parent == template)
              for (let item of found.sort((a, b) => (a.rank ?? 100) - (b.rank ?? 100))) resolve(item, null, innerTarget, false)
            } else {
              resolve(elt, null, innerTarget, fromTemplate)
            }
          }
          if (innerTarget != target && innerTarget.length) {
            if (innerTarget[innerTarget.length - 1] === "|") innerTarget.pop()
            if (innerTarget.length) target.push(new Menu.Submenu.Resolved(template as Menu.Submenu, innerTarget))
          } else if (template instanceof Menu.Group && template.margin) {
            margin(target)
          }
        } else {
          target.push(template)
        }
      }
    }

    let top: Menu.ResolvedItem[] = []
    if (Array.isArray(template)) {
      for (let elt of template) scan(elt)
      for (let elt of template) resolve(elt, null, top, true)
    } else {
      scan(template as Menu.Template)
      resolve(template as Menu.Template, null, top, true)
    }
    if (top.length && top[top.length - 1] === "|") top.pop()
    return top
  }
}
