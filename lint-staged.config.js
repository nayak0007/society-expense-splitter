/**
 * Pre-commit: format and fix staged files only (Roadmap T004).
 */
module.exports = {
  "*.{ts,tsx,js,jsx,cjs,mjs}": ["eslint --fix", "prettier --write"],
  "*.{json,css,md,yml,yaml}": ["prettier --write"],
};
