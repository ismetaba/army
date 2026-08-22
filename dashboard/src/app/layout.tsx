import type { Metadata } from "next";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";

/*
 * The create-next-app template loaded Geist from `next/font/google`. It is gone on purpose: the
 * panel is a local tool that has to start on a laptop with no network (and reads a store that is
 * itself local), and `next/font/google` fetches the font files at build/dev time. The system
 * sans/mono stacks in globals.css need no network and are the fonts the OS already renders best.
 */

export const metadata: Metadata = {
  title: "agent-workflows — run panel",
  description: "Workspaces and runs recorded by the agent-workflows CLI.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <SiteHeader />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </body>
    </html>
  );
}
