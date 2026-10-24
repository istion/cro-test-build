import "./globals.css";
import type { ReactNode } from "react";

export const metadata = { title: "CRO Score Agent", description: "Evidence-led conversion readiness score for one page, with the logic shown." };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (<html lang="en"><body>{children}</body></html>);
}
