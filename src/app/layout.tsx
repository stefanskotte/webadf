import type { Metadata } from "next";
import { Bricolage_Grotesque, Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const sans = Geist({ variable: "--font-sans", subsets: ["latin"] });
const mono = Geist_Mono({ variable: "--font-mono", subsets: ["latin"] });
const display = Bricolage_Grotesque({ variable: "--font-display", subsets: ["latin"], axes: ["opsz"] });

export const metadata: Metadata = {
  title: "webadf",
  description: "Your Amiga disk library, one click from the Gotek.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${display.variable} h-full`}>
      <body className="bg-page antialiased min-h-full flex flex-col">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
