import Link from "next/link";
import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <Link href="/" data-nav="home">
            Home
          </Link>
          <Link href="/products/42" data-nav="product">
            Product
          </Link>
          <Link href="/dashboard/users" data-nav="users">
            Users
          </Link>
          <Link href="/dashboard/orders" data-nav="orders">
            Orders
          </Link>
          <Link href="/interactive" data-nav="interactive">
            Interactive
          </Link>
          <Link href="/stream" data-nav="stream">
            Stream
          </Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
