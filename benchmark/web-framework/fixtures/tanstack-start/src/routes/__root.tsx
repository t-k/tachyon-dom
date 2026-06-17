import { HeadContent, Link, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <nav>
          <Link to="/" data-nav="home">
            Home
          </Link>
          <Link to="/products/$id" params={{ id: "42" }} data-nav="product">
            Product
          </Link>
          <Link to="/dashboard/users" data-nav="users">
            Users
          </Link>
          <Link to="/dashboard/orders" data-nav="orders">
            Orders
          </Link>
          <Link to="/stream" data-nav="stream">
            Stream
          </Link>
        </nav>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
