import { err, ok, type Result } from "../result.js";
import { hydrate, mount, type ClientTemplateModule, type HydrateError, type MountHandle } from "./mount.js";
import { createStore } from "./signal.js";

export type TemplateComponentOptions<
  Props extends object,
  Scope extends Record<string, unknown> = Record<string, unknown>,
> = {
  client: ClientTemplateModule<Scope>;
  scope?: (props: Props) => Scope;
  render?: (props: Props) => string;
  stream?: (props: Props) => AsyncIterable<string>;
};

export type TemplateComponentInstance<Props extends object> = MountHandle & {
  update: (props: Props) => void;
};

export type TemplateComponent<Props extends object, Scope extends Record<string, unknown> = Record<string, unknown>> = {
  client: ClientTemplateModule<Scope>;
  mount: (root: Element, props: Props) => TemplateComponentInstance<Props>;
  hydrate: (root: Element, props: Props) => Result<TemplateComponentInstance<Props>, HydrateError>;
  render: (props: Props) => string;
  stream: (props: Props) => AsyncIterable<string>;
};

const scopeFor = <Props extends object, Scope extends Record<string, unknown>>(
  options: TemplateComponentOptions<Props, Scope>,
  props: Props,
): Scope => (options.scope ? options.scope(props) : ({ ...props } as unknown as Scope));

const instanceFor = <Props extends object, Scope extends Record<string, unknown>>(
  scope: Scope,
  handle: MountHandle,
  options: TemplateComponentOptions<Props, Scope>,
): TemplateComponentInstance<Props> => {
  let scopeKeys = new Set<PropertyKey>(Reflect.ownKeys(scope));
  return {
    ...handle,
    update: (nextProps) => {
      if (handle.disposed()) return;
      const nextScope = scopeFor(options, nextProps);
      for (const key of scopeKeys) {
        if (!Reflect.has(nextScope, key)) {
          Reflect.set(scope, key, undefined);
        }
      }
      Object.assign(scope, nextScope);
      scopeKeys = new Set<PropertyKey>(Reflect.ownKeys(nextScope));
    },
  };
};

export const createTemplateComponent = <
  Props extends object,
  Scope extends Record<string, unknown> = Record<string, unknown>,
>(
  options: TemplateComponentOptions<Props, Scope>,
): TemplateComponent<Props, Scope> => {
  const createScope = (props: Props): Scope => createStore(scopeFor(options, props)) as Scope;
  const mountInstance = (root: Element, props: Props): TemplateComponentInstance<Props> => {
    const scope = createScope(props);
    const handle = mount(root, options.client, scope);
    return instanceFor(scope, handle, options);
  };
  const hydrateInstance = (root: Element, props: Props): Result<TemplateComponentInstance<Props>, HydrateError> => {
    const scope = createScope(props);
    const result = hydrate(root, options.client, scope);
    return result.ok ? ok(instanceFor(scope, result.value, options)) : err(result.error);
  };
  return {
    client: options.client,
    mount: mountInstance,
    hydrate: hydrateInstance,
    render: (props) => {
      if (!options.render) throw new Error("This template component does not provide a server renderer.");
      return options.render(props);
    },
    stream: (props) => {
      if (!options.stream) throw new Error("This template component does not provide a stream renderer.");
      return options.stream(props);
    },
  };
};
