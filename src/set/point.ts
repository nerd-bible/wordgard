import {ChangeSet} from "wordgard/doc"

/// Objects stored in a point set must conform to this interface.
export interface PointValue {
  /// The side of the point. Used to provide a sorting of points at
  /// the same position, and to determine cursor position relative to
  /// the points. Points with side < 0 are always displayed before a
  /// cursor at their position, those with side > 0 always after, and
  /// those with side == 0 before or after depending on the cursor's
  /// side.
  side: number
  /// Configures whether the point should be deleted when content next
  /// to it is deleted. See {@link ChangeSet.mapPos}.
  trackMode: ChangeSet.TrackMode | undefined
  /// Method to compare this value to another.
  eq(other: PointValue): boolean
}
