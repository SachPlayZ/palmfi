import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { Shell } from "@/components/shell";

export const metadata: Metadata = {
  title: "palmfi",
  description: "Protected vaults: your keys can be stolen, your money can't leave faster than you can say no.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
