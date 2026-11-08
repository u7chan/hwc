export const FOLDER_TRUST_SCREEN = `
  Folder access
  /workspace/acme-dashboard

  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.
  Folder settings can run code automatically, even without a model request. Continue only if you trust these files.
  Your trust decision will be saved.

› 1. Trust and continue
  2. Back to Agent Command Center

  enter continue · esc back
`;

export const PI_TRUST_SCREEN = `
────────────────────────────────────────────────────────────────────────────────────────────────────

 Trust project folder?
 /workspace/acme-dashboard

 This allows pi to load .pi settings and resources, install missing project packages, and execute project extensions.

 → Trust
   Trust parent folder (/workspace)
   Trust (this session only)
   Do not trust
   Do not trust (this session only)

 ↑↓ navigate  enter select  escape/ctrl+c cancel

────────────────────────────────────────────────────────────────────────────────────────────────────
`;
