import "./globals.css";
import type { ReactNode } from "react";
import { Inter, Fraunces } from "next/font/google";

/** Inter for body text. next/font self-hosts it and exposes it as the CSS variable --font-sans. */
const sans = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
/** Fraunces for headings and the score numerals, exposed as --font-serif. */
const serif = Fraunces({ subsets: ["latin"], variable: "--font-serif", display: "swap" });

/** Page title and description for browsers and link previews. */
export const metadata = { title: "CRO Score Agent", description: "Evidence-led conversion readiness score for one page, with the logic shown." };

/** Page shell: sets the language, attaches the font variables and renders the page inside <body>. */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (<html lang="en" className={`${sans.variable} ${serif.variable}`}><body>{children}</body></html>);
}
