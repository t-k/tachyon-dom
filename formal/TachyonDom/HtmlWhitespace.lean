import Std

namespace TachyonDom.HtmlWhitespace

/-- The only code-unit classes relevant to the short circuit. -/
inductive Glyph where
  | space | controlSpace | close | other
  deriving DecidableEq

private def wideSpace (next : Option Glyph) : Prop :=
  next = some .space ∨ next = some .controlSpace ∨ next = some .close

instance (next : Option Glyph) : Decidable (wideSpace next) :=
  inferInstanceAs (Decidable (_ ∨ _ ∨ _))

private def quietBoundary (glyph : Glyph) (next : Option Glyph) : Prop :=
  glyph ≠ .controlSpace ∧ (glyph = .space → ¬ wideSpace next)

/-- The raw input contains no character or adjacency that can make a tag edit possible. -/
def Quiet : List Glyph → Prop
  | [] => True
  | glyph :: rest => quietBoundary glyph rest.head? ∧ Quiet rest

private theorem quietPrefix (initial rest : List Glyph) :
    Quiet (initial ++ rest) → Quiet initial := by
  induction initial with
  | nil => simp [Quiet]
  | cons glyph tail ih =>
    intro quiet
    have tailQuiet := ih quiet.2
    cases tail with
    | nil =>
      exact ⟨⟨quiet.1.1, fun _ => by simp [wideSpace]⟩, trivial⟩
    | cons next remaining => exact ⟨quiet.1, tailQuiet⟩

private theorem quietSuffix (initial rest : List Glyph) :
    Quiet (initial ++ rest) → Quiet rest := by
  induction initial with
  | nil => exact id
  | cons _ _ ih => exact fun quiet => ih quiet.2

/-- Source spans from the parser are contiguous, so they inherit the no-edit condition. -/
theorem quietSlice (before tag after : List Glyph)
    (quiet : Quiet (before ++ (tag ++ after))) : Quiet tag :=
  quietPrefix tag after (quietSuffix before (tag ++ after) quiet)

private def emit (quoted : Bool) (glyph : Glyph) (next : Option Glyph) : Option Glyph :=
  if quoted then some glyph
  else if glyph = .space ∨ glyph = .controlSpace then
    if wideSpace next then none else some .space
  else some glyph

/-- A quiet tag emits each character unchanged, regardless of the quote state. A space run then has
length one, so the scanner also advances by exactly one code unit. -/
theorem quietBoundary_emitsIdentity (quoted : Bool) (glyph : Glyph) (next : Option Glyph)
    (quiet : quietBoundary glyph next) : emit quoted glyph next = some glyph := by
  cases quoted <;> cases glyph <;> simp_all [quietBoundary, emit]

private def scan (quoteState : Nat → Bool) : List Glyph → List Glyph
  | [] => []
  | glyph :: rest =>
    (emit (quoteState 0) glyph rest.head?).toList ++ scan (fun index => quoteState (index + 1)) rest

/-- The quote transitions need no assumptions because both states preserve quiet characters. -/
theorem quietScan_eq_input (input : List Glyph) (quoteState : Nat → Bool) (quiet : Quiet input) :
    scan quoteState input = input := by
  induction input generalizing quoteState with
  | nil => rfl
  | cons glyph rest ih =>
    simp [scan, quietBoundary_emitsIdentity _ _ _ quiet.1, ih _ quiet.2]

end TachyonDom.HtmlWhitespace
