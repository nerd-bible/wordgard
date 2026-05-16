import {type Wordgard} from "wordgard/editor"
import {Command} from "wordgard/command"
import {GardState, Transaction, Facet, PhraseSet} from "wordgard/state"
import {phrases} from "wordgard/phrases"
import {Mark} from "wordgard/doc"

import {canAddMarkInRange} from "./helper"
import {toggleMark as _toggleMark} from "./commands"

export namespace Menu {
  export type Label = PhraseSet.Ref | {icon: string, directional?: boolean} | LabelWidget

  export type LabelWidget = {
    render: (wg: Wordgard) => HTMLElement
    rerender?: (tr: Transaction) => boolean
    update?: (elt: HTMLElement, wg: Wordgard) => void
  }

  export type Item = Button | CustomControl | Submenu | Group

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
      parent?: Group | Submenu
      rank?: number
      description?: PhraseSet.Ref
    }

    export class Base {
      select: ((state: GardState) => boolean) | undefined
      enable: ((state: GardState) => boolean) | undefined
      updateFor: ((tr: Transaction) => boolean) | undefined
      parent: Group | Submenu | undefined
      rank: number
      description: PhraseSet.Ref | undefined

      /// @internal
      constructor(spec: Item.Spec) {
        this.select = spec.select
        this.enable = spec.enable
        this.updateFor = spec.updateFor
        this.parent = spec.parent
        this.rank = spec.rank ?? 100
        this.description = spec.description
      }
    }

    export const source = Facet.define<Item>()
  }

  export class Button extends Item.Base {
    label: Label
    run: Command.Bound | Command
    active: ((state: GardState) => boolean) | undefined
    extension: GardState.Extension

    private constructor(readonly spec: Button.Spec) {
      super(spec)
      this.run = spec.run
      this.active = spec.active
      this.label = spec.label
      this.extension = Item.source.of(this)
      if (this.parent) this.extension = [this.parent.extension, this.extension]
    }

    static define(spec: Button.Spec): Button { return new Button(spec) }
  }

  export namespace Button {
    export interface Spec extends Item.Spec {
      run: Command.Bound | Command
      active?: (state: GardState) => boolean
      label: Label
    }

    /// Creates a menu button that toggles an inline mark via {@link
    /// toggleMark}, and is shown as active when either that mark is part
    /// of the marks associated with the current cursor, or the selection
    /// covers only content with that mark.
    export function toggleMark(config: {
      mark: Mark<any>,
      parent?: Menu.Group | Menu.Submenu
      rank?: number
      description?: PhraseSet.Ref
      label: Menu.Label
    }) {
      let {mark, parent, rank, description, label} = config
      return Menu.Button.define({
        run: Command.bind(_toggleMark, mark),
        active(state) {
          let {selection} = state
          if (selection.isCursor)
            return !!mark.isInSet(state.sel.activeMarks)
          else
            return !selection.ranges.some(r => canAddMarkInRange(state.doc, r.from, r.to, mark))
        },
        parent,
        rank,
        description,
        label
      })
    }
  }

  export class CustomControl extends Item.Base {
    render: (wg: Wordgard, done: () => void) => {dom: HTMLElement, focus?: HTMLElement}
    setEnabled: ((dom: Element, enabled: boolean) => void) | undefined
    extension: GardState.Extension

    private constructor(readonly spec: CustomControl.Spec) {
      super(spec)
      this.render = spec.render
      this.setEnabled = spec.setEnabled
      this.extension = Item.source.of(this)
    }

    static define(spec: CustomControl.Spec) { return new CustomControl(spec) }

    config(spec: CustomControl.Spec) { return new CustomControl({...this.spec, ...spec}) }
  }

  export namespace CustomControl {
    export interface Spec extends Item.Spec {
      render: (wg: Wordgard, done: () => void) => {dom: HTMLElement, focus?: HTMLElement}
      setEnabled?: (focus: Element, enabled: boolean) => void
    }
  }

  export class Group {
    margin: boolean
    extension: GardState.Extension
    parent: Group | Submenu | undefined
    rank: number
    content: readonly (Item | "...")[] | undefined

    private constructor(readonly spec: Group.Spec) {
      this.margin = !!spec.margin
      this.extension = Item.source.of(this)
      this.parent = spec.parent
      this.rank = spec.rank ?? 100
      this.content = spec.content
    }

    template(...content: (Template | Item | "...")[]) {
      return new Template(this, content.length ? content : ["..."])
    }

    static define(spec: Group.Spec = {}) { return new Group(spec) }
  }

  export namespace Group {
    export interface Spec {
      margin?: boolean
      parent?: Group | Submenu
      rank?: number,
      content?: readonly (Item | "...")[]
    }

    export const top = Group.define()
    export const commands = Group.define({parent: Group.top, rank: 10})
    export const blockMenu = Group.define({parent: Group.top, rank: 50, margin: true})
    export const inlineStyle = Group.define({parent: Menu.Group.top, rank: 30, margin: true})
  }

  export class Submenu extends Item.Base {
    label: Label | undefined
    defaultLabel: Label | undefined
    arrow: boolean
    width: number | undefined
    content: readonly (Item | "...")[] | undefined
    extension: GardState.Extension

    private constructor(readonly spec: Submenu.Spec) {
      super(spec)
      this.label = spec.label
      this.defaultLabel = spec.defaultLabel
      this.arrow = spec.arrow !== false
      this.width = spec.width
      this.content = spec.content
      this.extension = Item.source.of(this)
    }

    template(...content: (Template | Item | "...")[]) {
      return new Template(this, content.length ? content : ["..."])
    }

    static define(spec: Submenu.Spec) { return new Submenu(spec) }
  }

  export namespace Submenu {
    export interface Spec extends Item.Spec {
      label?: Label
      defaultLabel?: Label
      arrow?: boolean
      width?: number,
      content?: readonly (Item | "...")[]
    }

    export class Resolved {
      constructor(readonly item: Submenu, readonly content: readonly ResolvedItem[]) {}
    }

    export const textblockStyle = Menu.Submenu.define({
      defaultLabel: phrases.ref("block_style"),
      description: phrases.ref("block_style"),
      parent: Group.top,
      rank: 5,
      width: 10,
    })
  }

  export class Template {
    parent: Group | Submenu | null
    rank: number

    constructor(readonly item: Group | Submenu, readonly content: readonly (Template | Item | "...")[] = []) {
      this.parent = item.parent ?? null
      this.rank = item.rank ?? 100
    }
  }

  export type ResolvedItem = Button | CustomControl | "|" | Submenu.Resolved

  export function resolve(
    items: readonly Item[],
    template: Template | readonly Template[] = Group.top.template(),
    suppress?: readonly Item[]
  ): readonly ResolvedItem[] {
    // 1 means not used yet, but will be used in template, so ignore
    // when filling items, 2 means used/suppressed
    let used = new Map<Item, number>()
    if (suppress) for (let item of suppress) used.set(item, 2)
    function scan(template: Template) {
      used.set(template.item, 1)
      for (let child of template.content) {
        if (child instanceof Template) scan(child)
        else if (typeof child != "string") used.set(child, 1)
      }
    }
    function margin(target: ResolvedItem[]) {
      if (target.length && target[target.length - 1] !== "|") target.push("|")
    }
    function resolve(template: Item | Template,
                     content: readonly (Template | Item | "...")[] | null,
                     target: ResolvedItem[],
                     fromTemplate: boolean) {
      if (template instanceof Template) {
        resolve(template.item, template.content, target, true)
      } else {
        let wasUsed = used.get(template)
        if (fromTemplate ? wasUsed == 2 : wasUsed != null) return
        used.set(template, 2)
        if (template instanceof Submenu || template instanceof Group) {
          if (template instanceof Group && template.margin) margin(target)
          let innerTarget: ResolvedItem[] = template instanceof Submenu ? [] : target
          for (let elt of content || template.content || ["..."]) {
            if (elt === "...") {
              let found: Item[] = items.filter(i => i.parent == template)
              for (let item of found.sort((a, b) => (a.rank ?? 100) - (b.rank ?? 100))) resolve(item, null, innerTarget, false)
            } else {
              resolve(elt, null, innerTarget, fromTemplate)
            }
          }
          if (innerTarget != target && innerTarget.length) {
            if (innerTarget[innerTarget.length - 1] === "|") innerTarget.pop()
            if (innerTarget.length) target.push(new Submenu.Resolved(template as Submenu, innerTarget))
          } else if (template instanceof Group && template.margin) {
            margin(target)
          }
        } else {
          target.push(template)
        }
      }
    }

    let top: ResolvedItem[] = []
    if (Array.isArray(template)) {
      for (let elt of template) scan(elt)
      for (let elt of template) resolve(elt, null, top, true)
    } else {
      scan(template as Template)
      resolve(template as Template, null, top, true)
    }
    if (top.length && top[top.length - 1] === "|") top.pop()
    return top
  }
}
