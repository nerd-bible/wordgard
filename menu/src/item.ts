import {Command} from "@wordgard/view"
import {EditorState} from "@wordgard/state"

export type MenuLabel = string | {icon: string}

export interface BaseMenuItem {
  type: string
  select?: (state: EditorState) => boolean
  enable?: (state: EditorState) => boolean
  parent?: MenuItem
  rank?: number
}

export interface MenuButton extends BaseMenuItem {
  type: "button"
  run: Command
  active?: (state: EditorState) => boolean
  // FIXME use 100x100 viewport for these, find better icons
  label: MenuLabel
  description: string
}

export interface MenuGroup extends BaseMenuItem {
  type: "group"
  margin?: boolean
}

export interface MenuSelect extends BaseMenuItem {
  type: "select"
  description: string
  label?: MenuLabel
  defaultLabel: MenuLabel
}

// FIXME make this easily extendable in 3rd party code, somehow
export type MenuItem = MenuButton | MenuGroup | MenuSelect

export class TemplateGroup {
  parent: MenuItem | null
  rank: number

  private constructor(readonly item: MenuItem, readonly content: readonly (MenuItem | "...")[] = []) {
    this.parent = item.parent ?? null
    this.rank = item.rank ?? 100
  }

  static of(item: MenuItem, ...content: (MenuItem | "...")[]) {
    return new TemplateGroup(item, content.length ? content : ["..."])
  }
}

export const Top: MenuGroup = {type: "group"}
export const Commands: MenuGroup = {type: "group", parent: Top, rank: 10}
export const InlineStyles: MenuGroup = {type: "group", parent: Top, rank: 30}

export const Alignment: MenuSelect = {
  type: "select",
  parent: Top,
  defaultLabel: {icon: "M2 12.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m0-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5m0-3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m0-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5"},
  rank: 50,
  description: "Text alignment"
}

export const Undo: MenuButton = {
  type: "button",
  run: () => { console.log("undo"); return true },
  label: {icon: "M8 3a5 5 0 1 1-4.55 2.91.5.5 0 0 0-.91-.42A6 6 0 1 0 8 2z M8 4.47V.534.25.25 0 0 0-.41-.19L5.23 2.31a.25.25 0 0 0 0 .38l2.36 1.97A.25.25 0 0 0 8 4.47"},
  description: "Undo",
  parent: Commands,
  rank: 10
}

export const Redo: MenuButton = {
  type: "button",
  run: () => { console.log("redo"); return true },
  label: {icon: "M8 3a5 5 0 1 0 4.55 2.91.5.5 0 0 1 .91-.42A6 6 0 1 1 8 2z M8 4.47V.53a.25.25 0 0 1 .41-.19l2.36 1.97c.12.1.12.28 0 .38L8.41 4.66A.25.25 0 0 1 8 4.47"},
  description: "Redo",
  parent: Commands,
  rank: 20
}

export const Strong: MenuButton = {
  type: "button",
  run: () => { console.log("strong"); return true },
  label: {icon: "M8.21 13c2.11 0 3.41-1.09 3.41-2.82 0-1.31-.98-2.28-2.32-2.39v-.06a2.18 2.18 0 0 0 1.85-2.14c0-1.51-1.16-2.46-3.014-2.46H3.843V13zM5.91 4.67h1.70c.96 0 1.52.45 1.52 1.24 0 .83-.63 1.32-1.73 1.32H5.91V4.67zm0 6.79V8.60h1.73c1.22 0 1.88.49 1.88 1.41 0 .94-.64 1.45-1.83 1.45H5.91z"},
  description: "Toggle strong emphasis",
  parent: InlineStyles,
  rank: 10
}

// FIXME use start/end nomenclature?
export const AlignLeft: MenuButton = {
  type: "button",
  run: () => { console.log("left"); return true },
  label: {icon: "M2 12.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m0-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5m0-3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m0-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5"},
  description: "Align left",
  parent: Alignment,
  rank: 10
}

export const AlignRight: MenuButton = {
  type: "button",
  run: () => { console.log("right"); return true },
  label: {icon: "M6 12.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m-4-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5m4-3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m-4-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5"},
  description: "Align right",
  parent: Alignment,
  rank: 20
}

export const AlignCenter: MenuButton = {
  type: "button",
  run: () => { console.log("center"); return true },
  label: {icon: "M4 12.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m-2-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5m2-3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5m-2-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5"},
  description: "Center",
  parent: Alignment,
  active: () => true,
  rank: 30
}

// FIXME automatic generation from facet
export const staticMenu: MenuItem[] = [Undo, Redo, Strong, AlignLeft, AlignRight, AlignCenter, Commands, InlineStyles, Alignment]

export class ResolvedGroup {
  constructor(readonly item: MenuItem,
              readonly content: readonly (MenuItem | ResolvedGroup)[]) {}
}

export function resolveMenu(
  items: readonly MenuItem[],
  template: TemplateGroup | readonly TemplateGroup[] = TemplateGroup.of(Top)
): readonly (MenuItem | ResolvedGroup)[] {
  let used = new Set<MenuItem>()
  function resolve(template: MenuItem | TemplateGroup, content: readonly (MenuItem | "...")[] | null,
                   target: (MenuItem | ResolvedGroup)[]) {
    if (template instanceof TemplateGroup) {
      resolve(template.item, template.content, target)
    } else {
      if (used.has(template)) return
      used.add(template)
      if (template.type == "select" || template.type == "group") {
        let innerTarget: (MenuItem | ResolvedGroup)[] = template.type == "select" ? [] : target
        for (let elt of content || ["..."]) {
          if (elt === "...") {
            let found: MenuItem[] = items.filter(i => i.parent == template)
            for (let item of found.sort((a, b) => (a.rank ?? 100) - (b.rank ?? 100))) resolve(item, null, innerTarget)
          } else {
            resolve(elt, null, innerTarget)
          }
        }
        if (innerTarget != target && innerTarget.length)
          target.push(new ResolvedGroup(template, innerTarget))
      } else {
        target.push(template)
      }
    }
  }

  let top: (MenuItem | ResolvedGroup)[] = []
  if (Array.isArray(template)) for (let elt of template) resolve(elt, null, top)
  else resolve(template as TemplateGroup, null, top)
  return top
}
