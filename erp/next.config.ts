import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // pdfmake and bwip-js are CommonJS renderers with their own internal `require` graphs (pdfkit,
  // fontkit, iconv-lite) and a megabyte of embedded base64 font data. Left to the bundler they
  // get inlined into every route chunk that touches the traveler; declared external they are
  // `require`d at runtime instead, and `output: "standalone"`'s file tracing copies them into
  // the image the same way it copies Prisma's engine.
  serverExternalPackages: ["pdfmake", "bwip-js"],
};

export default nextConfig;
