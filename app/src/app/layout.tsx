export const metadata = { title: "Ploot · Scheduler demo" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: 16, background: "#fafafa", color: "#111" }}>{children}</body>
    </html>
  );
}
