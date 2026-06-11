import { runDesktopMain } from "./packaged-main.js";

void runDesktopMain().catch((error) => {
  console.error("PaperClip Desktop fatal error", error);
  process.exit(1);
});
