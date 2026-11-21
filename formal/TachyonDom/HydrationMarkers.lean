import TachyonDom.QueryGrouping

namespace TachyonDom.HydrationMarkers

variable {Key Comment : Type} [DecidableEq Key]

/-- The marker key includes its kind and ID. Unrelated comments leave both indexes unchanged. -/
def addComment (classify : Comment → Option Key) (groups : Key → List Comment)
    (comment : Comment) : Key → List Comment :=
  match classify comment with
  | none => groups
  | some key => QueryGrouping.addKnown (fun _ => true) groups (key, comment)

/-- Classifying during the walk preserves the exact buckets produced by collecting
markers first, including duplicate comments and their document order. -/
theorem stream_eq_collect (classify : Comment → Option Key) (comments : List Comment)
    (groups : Key → List Comment) :
    comments.foldl (addComment classify) groups =
      (comments.filterMap (fun comment => (classify comment).map (fun key => (key, comment)))).foldl
        (QueryGrouping.addKnown (fun _ => true)) groups := by
  induction comments generalizing groups with
  | nil => rfl
  | cons comment rest ih =>
    cases found : classify comment with
    | none => simpa [addComment, found] using ih groups
    | some key =>
      simpa [addComment, found] using ih (QueryGrouping.addKnown (fun _ => true) groups (key, comment))

end TachyonDom.HydrationMarkers
