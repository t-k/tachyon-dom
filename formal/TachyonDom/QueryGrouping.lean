import Std

namespace TachyonDom.QueryGrouping

variable {Key Value : Type} [DecidableEq Key]

/-- The ordered list of values returned by one native query-parameter lookup. -/
def getAll (name : Key) (pairs : List (Key × Value)) : List Value :=
  pairs.filterMap (fun (key, value) => if key = name then some value else none)

/-- Appending to the corresponding bucket leaves every other bucket unchanged. -/
def addKnown (known : Key → Bool) (groups : Key → List Value) (pair : Key × Value) :
    Key → List Value :=
  fun name =>
    if known pair.1 && decide (pair.1 = name) then groups name ++ [pair.2] else groups name

/-- Grouping in source order preserves lookup order and duplicate values for every selected field. -/
theorem group_eq_getAll (known : Key → Bool) (name : Key) (pairs : List (Key × Value))
    (isKnown : known name = true) :
    (pairs.foldl (addKnown known) (fun _ => [])) name = getAll name pairs := by
  have append_result (groups : Key → List Value) :
      (pairs.foldl (addKnown known) groups) name = groups name ++ getAll name pairs := by
    induction pairs generalizing groups with
    | nil => simp [getAll]
    | cons pair rest ih =>
      obtain ⟨key, value⟩ := pair
      rw [List.foldl_cons, ih]
      by_cases same : key = name
      · subst key
        simp [getAll, addKnown, isKnown]
      · simp [getAll, addKnown, same]
  simpa using append_result (fun _ => [])

end TachyonDom.QueryGrouping
