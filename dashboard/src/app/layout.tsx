import type { Metadata } from "next";
import { Archivo, Martian_Mono } from "next/font/google";
import "./globals.css";

/*
 * The Ledger design specifies two families (handoff § Type): Archivo for everything a human
 * wrote, Martian Mono for everything a machine wrote or addresses. `next/font/google` fetches
 * them at BUILD time and self-hosts the files, so the running panel still needs no network —
 * which is why the template's runtime <link> to fonts.googleapis.com is not used here. Both
 * declare a system fallback, so a build that could not reach Google still renders.
 */
const archivo = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-archivo",
  display: "swap",
  fallback: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
});

const martian = Martian_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-martian",
  display: "swap",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
});

export const metadata: Metadata = {
  title: "agent-workflows — panel",
  description: "Workspaces, tasks and results recorded by the agent-workflows CLI.",
};

/*
 * No global header: each level of the flow carries its own top bar (the entry screen's is a
 * plain rule with the local address, the workspace screens carry the switcher and health), so
 * the shell here is only the page frame.
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`h-full antialiased ${archivo.variable} ${martian.variable}`}>
      <body className="min-h-full bg-bg text-fg">{children}</body>
    </html>
  );
}
