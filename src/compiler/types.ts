export type CompilerError = {
  message: string;
  offset: number;
};

export type Attribute = {
  name: string;
  value: string | true;
};

export type ElementNode = {
  type: "element";
  tagName: string;
  attrs: Attribute[];
  children: TemplateNode[];
};

export type TextNode = {
  type: "text";
  value: string;
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

export type ListBinding = {
  kind: "list";
  path: number[];
  each: string;
  itemName: string;
  key: string;
  templateHtml: string;
  bindings: ClientBinding[];
};

export type ConditionalBinding = {
  kind: "if";
  path: number[];
  test: string;
  templateHtml: string;
  bindings: Array<TextBinding | ClassBinding | EventBinding>;
};

export type ClientBinding = TextBinding | ClassBinding | EventBinding | ListBinding | ConditionalBinding;

export type StoreDefinition = {
  name: string;
  initial: string;
};

export type HydrationBoundary = {
  path: number[];
  id: string;
};

export type ComponentProp = {
  name: string;
  expression: string;
};

export type TemplateDirective =
  | { kind: "for"; path: number[]; each: string; key: string; itemName: string }
  | { kind: "if"; path: number[]; test: string }
  | { kind: "store"; path: number[]; stores: StoreDefinition[] }
  | { kind: "event"; path: number[]; eventName: string; handler: string }
  | { kind: "component"; path: number[]; name: string; props: ComponentProp[]; stores: StoreDefinition[] }
  | { kind: "hydrate"; path: number[]; id: string };

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
  };
};

export type LoweringContext = {
  bindings: ClientBinding[];
  stores: StoreDefinition[];
  hydrationBoundaries: HydrationBoundary[];
};

export type GenerateClientModuleOptions = {
  reactive?: boolean;
};
