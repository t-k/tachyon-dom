export type CompilerError = {
  message: string;
  offset: number;
  endOffset?: number;
};

export type TemplateWhitespacePolicy = "preserve" | "condense";

export type CompileTemplateOptions = {
  whitespace?: TemplateWhitespacePolicy;
};

export type Attribute = {
  name: string;
  value: string | true;
  start?: number;
  end?: number;
  nameStart?: number;
  nameEnd?: number;
  valueStart?: number;
  valueEnd?: number;
};

export type ElementNode = {
  type: "element";
  start?: number;
  end?: number;
  openEnd?: number;
  tagName: string;
  attrs: Attribute[];
  children: TemplateNode[];
};

export type TextNode = {
  type: "text";
  value: string;
  start?: number;
  end?: number;
};

export type TemplateNode = ElementNode | TextNode;

export type TextBinding = {
  kind: "text";
  path: number[];
  expression: string;
};

export type ClassBinding = {
  kind: "class";
  path: number[];
  className: string;
  expression: string;
};

export type EventBinding = {
  kind: "event";
  path: number[];
  eventName: string;
  handler: string;
};

export type AttributeBinding = {
  kind: "attr";
  path: number[];
  name: string;
  expression: string;
};

export type StyleBinding = {
  kind: "style";
  path: number[];
  name: string;
  expression: string;
};

export type RefBinding = {
  kind: "ref";
  path: number[];
  expression: string;
};

export type ModelBinding = {
  kind: "model";
  path: number[];
  property: "value" | "checked";
  expression: string;
};

export type ListBinding = {
  kind: "list";
  path: number[];
  each: string;
  itemName: string;
  indexName?: string;
  key: string;
  updatePolicy?: "always" | "reference";
  region?: ListRegion;
  templateHtml: string;
  bindings: ClientBinding[];
  stores?: StoreDefinition[];
  hydrationBoundaries?: HydrationBoundary[];
  components?: ComponentBoundary[];
};

/**
 * Where a list sits in its parent. `index` is the ordinal of its marker pair among the parent's own list
 * regions and `at` the logical child index its rows start at; both default to 0 and are omitted then.
 */
export type ListRegion = {
  index?: number;
  at?: number;
};

export type ConditionalBinding = {
  kind: "if";
  path: number[];
  test: string;
  templateHtml: string;
  bindings: ClientBinding[];
  stores?: StoreDefinition[];
  hydrationBoundaries?: HydrationBoundary[];
  components?: ComponentBoundary[];
};

export type ClientBinding =
  | TextBinding
  | ClassBinding
  | EventBinding
  | AttributeBinding
  | StyleBinding
  | RefBinding
  | ModelBinding
  | ListBinding
  | ConditionalBinding;

export type StoreDefinition = {
  name: string;
  initial: string;
};

export type HydrationBoundary = {
  path: number[];
  id: string;
  idKind?: "expression" | "static";
  strategy?: "load" | "idle" | "visible" | "media" | "interaction";
  media?: string;
  interaction?: string;
  rootMargin?: string;
};

export type HydrationDynamicRegion = {
  path: number[];
  index: number;
  kind: "list" | "conditional";
};

export type ComponentProp = {
  name: string;
  expression: string;
};

export type ComponentBoundary = {
  path: number[];
  name: string;
  props: ComponentProp[];
  stores: StoreDefinition[];
};

export type TemplateDirective =
  | { kind: "for"; path: number[]; each: string; key: string; itemName: string; indexName?: string }
  | { kind: "if"; path: number[]; test: string }
  | { kind: "store"; path: number[]; stores: StoreDefinition[] }
  | { kind: "event"; path: number[]; eventName: string; handler: string }
  | { kind: "component"; path: number[]; name: string; props: ComponentProp[]; stores: StoreDefinition[] }
  | {
      kind: "await";
      path: number[];
      value: string;
      thenName: string;
      /** HTML yielded by the stream target before awaiting. It is appended output and is not replaced. */
      pending?: string;
      /** Alias of `pending`, kept for IR consumers that read the original attribute name. */
      fallback?: string;
      error?: string;
      reorder?: "preserve" | "resolve";
    }
  | {
      kind: "hydrate";
      path: number[];
      id: string;
      idKind?: "expression" | "static";
      strategy?: "load" | "idle" | "visible" | "media" | "interaction";
      media?: string;
      interaction?: string;
      rootMargin?: string;
    };

export type TemplateIr = {
  kind: "template";
  root: ElementNode;
  directives: TemplateDirective[];
};

export type CompiledTemplate = {
  source: string;
  ir: TemplateIr;
  root: ElementNode;
  client: {
    templateHtml: string;
    bindings: ClientBinding[];
    stores: StoreDefinition[];
    hydrationBoundaries: HydrationBoundary[];
    hydrationDynamicRegions: HydrationDynamicRegion[];
    hydrationDynamicRegionErrors: string[];
    components: ComponentBoundary[];
  };
};

export type LoweringContext = {
  bindings: ClientBinding[];
  stores: StoreDefinition[];
  hydrationBoundaries: HydrationBoundary[];
  hydrationDynamicRegions: HydrationDynamicRegion[];
  hydrationDynamicRegionErrors: string[];
  components: ComponentBoundary[];
};

export type GenerateClientModuleOptions = {
  reactive?: boolean;
  defaultScopeName?: string;
  hydrationChunkImports?: Readonly<Record<string, string>>;
  hydrationBoundaryId?: string;
  /** Internal: the module is a boundary chunk that binds with an entry-provided hydration context. */
  hydrationChunk?: boolean;
  /**
   * Generate a hydrate-only module: boundary bindings and their runtime
   * imports are removed from the module and `bind` is not exported.
   */
  hydrateOnly?: boolean;
  /**
   * Generate a mount-only module: hydration metadata, the hydrate entry, and the server shape matching a
   * conditional needs to adopt SSR output are all left out. Exclusive with `hydrateOnly` and hydration chunks.
   */
  mountOnly?: boolean;
  /**
   * Binding location instrumentation. Direct compiler output enables it by
   * default with a deterministic anonymous identity. Vite disables it for
   * builds that do not have a development source root; production defines can
   * also remove it from a generated module.
   */
  instrumentBindings?: boolean;
  /** Optional source identity for development binding diagnostics. */
  templateId?: string;
  /** Revision of the source the spans belong to (for example a content hash). */
  sourceRevision?: string;
  /** Maps template offsets to source offsets (SFC scripts shift the template). */
  mapSourceOffset?: (offset: number) => number;
};
