import Std

namespace TachyonDom.ListAppend

/-- Once the append check has found the old-only prefix and new-only suffix, their boundary selects exactly
the rows that the old membership filter selected. The result includes the empty-prefix and empty-suffix cases. -/
theorem appendSuffix_eq_filter {α : Type} (old : α → Bool) (retained added : List α)
    (retainedOld : ∀ row ∈ retained, old row = true)
    (addedNew : ∀ row ∈ added, old row = false) :
    (retained ++ added).filter (fun row => !old row) = (retained ++ added).drop retained.length := by
  have filterRetained : retained.filter (fun row => !old row) = [] := by
    induction retained with
    | nil => rfl
    | cons row rest ih =>
      have head := retainedOld row (by simp)
      have tail := ih (fun r h => retainedOld r (List.mem_cons_of_mem _ h))
      simp [head, tail]
  have filterAdded : added.filter (fun row => !old row) = added := by
    apply List.filter_eq_self.mpr
    intro row h
    simp [addedNew row h]
  simp [List.filter_append, filterRetained, filterAdded]

end TachyonDom.ListAppend
