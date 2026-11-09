const nextConfig = {
  poweredByHeader: false,
  logging: { incomingRequests: { ignore: [/\/api\/events/] } },
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
  compress: false, // Keep SSE updates unbuffered.
  serverExternalPackages: ["node:sqlite"],
  outputFileTracingIncludes: {
    "/api/*": [
      "./data/words.json",
      "./data/vectors.bin",
      "./data/manifest.json",
    ],
  },
  async rewrites() {
    return [
      { source: "/health/:path*", destination: "/api/health/:path*" },
      { source: "/metrics", destination: "/api/metrics" },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};
export default nextConfig;
