export type TemplateScope = Record<string, unknown>;

export type TypedTemplate<Scope extends TemplateScope, Source extends string = string> = {
  source: Source;
  __scope?: (scope: Scope) => void;
};

export const defineTemplate = <Scope extends TemplateScope, const Source extends string>(
  source: Source,
): TypedTemplate<Scope, Source> => ({ source });

export const templateScope = <Scope extends TemplateScope>() => ({
  define: <const Source extends string>(source: Source): TypedTemplate<Scope, Source> =>
    defineTemplate<Scope, Source>(source),
});
