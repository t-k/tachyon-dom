import Std

namespace TachyonDom.PlainExpressions

inductive Value where
  | plain
  | accessor
  deriving DecidableEq

/-- Any of these operators returns one of its two alternatives. The condition or short-circuit rule determines
which alternative is evaluated or reused. -/
inductive Selection where
  | conditional
  | and
  | or
  | nullish

/-- Primitive-producing operators and literal objects are plain leaves. Scope reads and calls are unknown. -/
inductive Expr where
  | plain
  | unknown
  | select (kind : Selection) (left right : Expr)

/-- A conservative semantics for normally completing evaluations. For a selection, either side may win. -/
inductive Returns : Expr → Value → Prop where
  | plain : Returns .plain .plain
  | unknown {value : Value} : Returns .unknown value
  | left {kind : Selection} {lhs rhs : Expr} {value : Value} :
      Returns lhs value → Returns (.select kind lhs rhs) value
  | right {kind : Selection} {lhs rhs : Expr} {value : Value} :
      Returns rhs value → Returns (.select kind lhs rhs) value

def alwaysPlain : Expr → Bool
  | .plain => true
  | .unknown => false
  | .select _ lhs rhs => alwaysPlain lhs && alwaysPlain rhs

theorem returnsPlain {expr : Expr} {value : Value} (returns : Returns expr value) :
    alwaysPlain expr = true → value = .plain := by
  induction returns with
  | plain => intro _; rfl
  | unknown => simp [alwaysPlain]
  | left _ ih =>
    intro proof
    simp [alwaysPlain] at proof
    exact ih proof.1
  | right _ ih =>
    intro proof
    simp [alwaysPlain] at proof
    exact ih proof.2

/-- The runtime unwrap is the identity on all values the analysis accepts. -/
theorem skipUnwrap {expr : Expr} {value : Value} (unwrap : Value → Value)
    (plainUnchanged : unwrap .plain = .plain) (returns : Returns expr value)
    (sound : alwaysPlain expr = true) : unwrap value = value := by
  rw [returnsPlain returns sound, plainUnchanged]

end TachyonDom.PlainExpressions
