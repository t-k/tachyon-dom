import { catchError, createErrorBoundary, createResource, createSignal, effect } from "../src/index";
import { createI18n, localeMiddleware } from "../src/i18n";
import { createClientRouter, defineClientRoute } from "../src/runtime/router";

type ExampleUser = {
  id: string;
  name: string;
};

export const createRuntimeApiExample = () => {
  const userId = createSignal("42");
  const user = createResource(userId, async (id): Promise<ExampleUser> => ({ id, name: `User ${id}` }));
  const i18n = createI18n({
    defaultLocale: "en",
    locales: ["en", "ja"] as const,
    messages: {
      en: { greeting: "Hello {name}" },
      ja: { greeting: "こんにちは{name}" },
    },
  });
  const requireLocale = localeMiddleware({
    defaultLocale: "en",
    locales: ["en", "ja"] as const,
  });
  const recoveredErrors: string[] = [];
  const disposeErrorHandler = catchError(
    () => {
      if (user.error()) {
        throw user.error();
      }
    },
    (error) => {
      recoveredErrors.push(error instanceof Error ? error.message : String(error));
    },
  );

  return { userId, user, i18n, requireLocale, recoveredErrors, disposeErrorHandler };
};

export const mountErrorBoundaryExample = (root: Element) =>
  createErrorBoundary(root, {
    render: (target) => {
      target.textContent = "Ready";
    },
    fallback: (error) => `<p role="alert">${error instanceof Error ? error.message : "Unknown error"}</p>`,
  });

export const mountClientRouterExample = (root: Element) => {
  const userRoute = defineClientRoute({
    path: "/users/:id",
    load: ({ params }) => ({ id: params.id }),
    render: ({ data, params }) => `<h1>User ${params.id}: ${data.id}</h1>`,
  });
  const router = createClientRouter({
    root,
    viewTransition: ({ url }) => url.pathname !== "/settings",
    routes: [
      {
        path: "/",
        render: () => "<h1>Home</h1>",
      },
      userRoute,
    ],
  });
  return router;
};

type ScrollRestoringRouter = {
  navigate: (href: string, options?: { replace?: boolean; restoreScroll?: boolean }) => Promise<void>;
};

export const restoreCurrentScrollExample = (router: ScrollRestoringRouter) =>
  router.navigate(`${location.pathname}${location.search}${location.hash}`, {
    replace: true,
    restoreScroll: true,
  });

export const mountResourceStatusExample = (root: Element) => {
  const example = createRuntimeApiExample();
  const dispose = effect(() => {
    root.textContent = example.user.loading()
      ? "Loading"
      : (example.user.data()?.name ?? example.i18n.t("en", "greeting", { name: "Guest" }));
  });
  return () => {
    dispose();
    example.disposeErrorHandler();
  };
};
