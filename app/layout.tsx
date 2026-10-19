import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "next-themes";

import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ember — Indonesia Forest Fire Monitor",
  description:
    "Ember maps near-real-time NASA FIRMS VIIRS thermal anomalies over an Indonesia-centred bounding box, with regional views, confidence filters and honest source reporting.",
  applicationName: "Ember",
  keywords: [
    "Indonesia",
    "forest fire",
    "wildfire",
    "thermal anomaly",
    "VIIRS",
    "NASA FIRMS",
    "near-real-time",
    "monitoring",
  ],
  authors: [{ name: "Ember" }],
  openGraph: {
    title: "Ember — Indonesia Forest Fire Monitor",
    description:
      "Near-real-time thermal anomaly monitoring for Indonesia, powered by NASA FIRMS VIIRS.",
    type: "website",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
    apple: "/favicon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#14261e",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem={false}
          forcedTheme="light"
        >
          {children}
          <Toaster position="bottom-right" closeButton richColors={false} />
        </ThemeProvider>
      </body>
    </html>
  );
}
