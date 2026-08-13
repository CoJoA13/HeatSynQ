import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // pdfmake and bwip-js are CommonJS renderers with their own internal `require` graphs (pdfkit,
  // fontkit, iconv-lite) and a megabyte of embedded base64 font data. Left to the bundler they
  // get inlined into every route chunk that touches the traveler; declared external they are
  // `require`d at runtime instead, and `output: "standalone"`'s file tracing copies them into
  // the image the same way it copies Prisma's engine.
  serverExternalPackages: ["pdfmake", "bwip-js"],
  // The vendored .ttf assets (Phase 7 spec §6.2) are read with `readFileSync` from an app-root
  // path the tracer cannot follow, so every route is told to carry them: they land at
  // `.next/standalone/src/server/pdf/fonts/**`, which the Docker run stage copies to
  // `/app/src/server/pdf/fonts/**` — exactly where render.ts's `process.cwd()`-resolved read
  // looks. The build compiling is NOT proof the trace worked; `ls` the standalone output after
  // touching this (Task 6 report has the listing).
  outputFileTracingIncludes: {
    "/**": ["./src/server/pdf/fonts/**/*.ttf"],
  },
};

export default nextConfig;
