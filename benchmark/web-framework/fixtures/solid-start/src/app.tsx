import { A, Router } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { Suspense } from "solid-js";

export default function App() {
  return (
    <Router
      root={(props) => (
        <>
          <nav>
            <A href="/" data-nav="home">
              Home
            </A>
            <A href="/products/42" data-nav="product">
              Product
            </A>
            <A href="/dashboard/users" data-nav="users">
              Users
            </A>
            <A href="/dashboard/orders" data-nav="orders">
              Orders
            </A>
            <A href="/stream" data-nav="stream">
              Stream
            </A>
          </nav>
          <Suspense>{props.children}</Suspense>
        </>
      )}
    >
      <FileRoutes />
    </Router>
  );
}
