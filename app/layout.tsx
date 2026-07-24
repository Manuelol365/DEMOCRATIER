import type { Metadata } from "next";
import { Space_Grotesk, Syne } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const body = Space_Grotesk({ variable: "--font-body", subsets: ["latin"] });
const display = Syne({ variable: "--font-display", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  return {
    metadataBase: new URL(origin),
    title: "DEMOCRATIER — La tier list multijugador",
    description: "Crea una sala, vota con tus amigos y descubre quién entiende mejor al grupo.",
    openGraph: {
      title: "DEMOCRATIER — La tier list multijugador",
      description: "Crea una sala, vota con tus amigos y descubre quién entiende mejor al grupo.",
      images: [{ url: `${origin}/og.png`, width: 1734, height: 907, alt: "DEMOCRATIER: Tus opiniones. Una tier list." }],
    },
    twitter: { card: "summary_large_image", images: [`${origin}/og.png`] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="es"><body className={`${body.variable} ${display.variable}`}>{children}</body></html>;
}
