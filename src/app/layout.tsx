import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Source — AI Sourcing Platform",
  description: "AI-powered procurement platform. Describe what you need to buy or rent, and get complete sourcing packages with suppliers, RFQ documents, and personalized emails.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
