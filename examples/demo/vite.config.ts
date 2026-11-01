import { defineConfig } from "vite";
import auto from "content-mapper-auto/vite";

export default defineConfig({
  // Options (cache directory, model, instructions, ...) are read from the
  // content-mapper-auto entry in tsconfig.json, so Vite and tsc share one cache.
  plugins: [auto()],
});
