import { defineConfig } from "vitest/config";
import tsConfigPaths from "vite-tsconfig-paths";

/**
 * The normalisation engine and the form-warning layer that reads it are pure —
 * no DOM, no React — so they get their own config rather than running through
 * the app's Vite/Nitro pipeline.
 */
export default defineConfig({
  plugins: [tsConfigPaths()],
  test: {
    include: ["src/lib/**/*.test.ts"],
    environment: "node",
  },
});
