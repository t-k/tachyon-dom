import Std

namespace TachyonDom.LogicalNode

/-- Both DOM walkers share one marker scan. In its output, visible nodes are `some` and skipped steps are `none`. -/
def selectFrom {α : Type} : List (Option α) → Nat → Nat → Option α
  | [], _, _ => none
  | none :: rest, target, ordinal => selectFrom rest target ordinal
  | some node :: rest, target, ordinal =>
      if ordinal = target then some node else selectFrom rest target (ordinal + 1)

/-- Early lookup at a given visible ordinal equals indexing the collected visible nodes. -/
theorem selectFrom_eq_getElem {α : Type} (steps : List (Option α)) (ordinal index : Nat) :
    selectFrom steps (ordinal + index) ordinal = (steps.filterMap id)[index]? := by
  induction steps generalizing ordinal index with
  | nil => simp [selectFrom]
  | cons step rest ih =>
    cases step with
    | none => simpa [selectFrom] using ih ordinal index
    | some node =>
      cases index with
      | zero => simp [selectFrom]
      | succ index =>
        have before : ordinal ≠ ordinal + (index + 1) := by omega
        have shifted : ordinal + (index + 1) = (ordinal + 1) + index := by omega
        simp only [selectFrom, before, ite_false]
        rw [shifted]
        simpa using ih (ordinal + 1) index

/-- The production lookup begins with no visible nodes counted. -/
theorem select_eq_getElem {α : Type} (steps : List (Option α)) (index : Nat) :
    selectFrom steps index 0 = (steps.filterMap id)[index]? := by
  simpa using selectFrom_eq_getElem steps 0 index

end TachyonDom.LogicalNode
