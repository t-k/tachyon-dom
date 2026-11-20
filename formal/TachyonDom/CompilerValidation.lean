import Std

namespace TachyonDom.CompilerValidation

/-- A raw-text context restricts text expressions and leaves attribute syntax checks unchanged. -/
def expressionAllowed (inRawText isText validSyntax : Bool) : Bool :=
  validSyntax && !(inRawText && isText)

/-- A subtree scan that resets an inherited raw-text context can only weaken its checks. -/
theorem resetContext_preservesSuccess (inherited introducedHere isText validSyntax : Bool)
    (success : expressionAllowed (inherited || introducedHere) isText validSyntax = true) :
    expressionAllowed introducedHere isText validSyntax = true := by
  cases inherited <;> cases introducedHere <;> cases isText <;> cases validSyntax <;>
    simp_all [expressionAllowed]

private def firstError {ε : Type} : List (Option ε) → Option ε
  | [] => none
  | none :: rest => firstError rest
  | some error :: _ => some error

private def withExpressionRechecks {ε : Type} : List (Option ε × Option ε) → List (Option ε)
  | [] => []
  | (expressionError, structuralError) :: rest =>
    expressionError :: structuralError :: withExpressionRechecks rest

/-- After successful root validation, removing successful rechecks preserves the first structural diagnostic. -/
theorem omitSuccessfulRechecks {ε : Type} (steps : List (Option ε × Option ε))
    (success : ∀ step ∈ steps, step.1 = none) :
    firstError (withExpressionRechecks steps) = firstError (steps.map Prod.snd) := by
  induction steps with
  | nil => rfl
  | cons step rest ih =>
    obtain ⟨expressionError, structuralError⟩ := step
    have empty : expressionError = none := success (expressionError, structuralError) (by simp)
    subst expressionError
    have tail := ih (fun step h => success step (List.mem_cons_of_mem _ h))
    cases structuralError <;> simp [withExpressionRechecks, firstError, tail]

private def frozenAfter {α : Type} (frozen : α → Prop) (reachable : List α) (object : α) : Prop :=
  frozen object ∨ object ∈ reachable

/-- The cache wrapper reaches every payload object, so freezing the payload first adds no frozen objects. -/
theorem innerFreezeRedundant {α : Type} (frozen : α → Prop) (payload wrapper : List α)
    (reachable : payload ⊆ wrapper) :
    frozenAfter (frozenAfter frozen payload) wrapper = frozenAfter frozen wrapper := by
  funext object
  apply propext
  unfold frozenAfter
  constructor
  · rintro ((h | h) | h)
    · exact Or.inl h
    · exact Or.inr (reachable h)
    · exact Or.inr h
  · rintro (h | h)
    · exact Or.inl (Or.inl h)
    · exact Or.inr h

end TachyonDom.CompilerValidation
