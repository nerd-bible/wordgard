import {Leaf, Mark, Reject} from "wordgard/doc"

export const Image = Leaf.Type.defineInline<string>("Image", {
  validateParam: "string",
  shape: {element: "img", attributes: src => ({src}), readElement: elt => (elt as HTMLImageElement).src || Reject},
  selectable: true
})

export const ImageAlt = Mark.Type.define<string>("ImageAlt", {
  tags: "Image",
  validate: "string",
  shape: {attribute: "alt", readAttribute: x => x}
})

export const ImageSize = Mark.Type.define<{width: number, height: number}>("ImageSize", {
  tags: "Image",
  validate: value => {
    if (!value || typeof value.width != "number" || value.width < 0 || typeof value.height != "number" || value.height < 0)
      throw new Error("Invalid image size: " + JSON.stringify(value))
  },
  shape: {attribute: "style", value: size => `width: ${size.width}px; height: ${size.height}px`}
})
