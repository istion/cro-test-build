import "./globals.css";
import type { ReactNode } from "react";
import { Inter, Fraunces } from "next/font/google";

const sans = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const serif = Fraunces({ subsets: ["latin"], variable: "--font-serif", display: "swap" });

export const metadata = { title: "CRO Score Agent", description: "Evidence-led conversion readiness score for one page, with the logic shown." };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (<html lang="en" className={`${sans.variable} ${serif.variable}`}><body>{children}</body></html>);
}
