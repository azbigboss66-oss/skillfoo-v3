import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from 'node:child_process';
import { RELEASE_ID } from './src/release.ts';

export default defineConfig({
  plugins: [react(), {
    name: 'portfolio-release-identity',
    generateBundle() {
      const sourceCommit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim();
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ releaseId: RELEASE_ID, sourceCommit }) });
    },
  }],
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
  },
});
