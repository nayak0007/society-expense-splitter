/**
 * Ambient module declarations for non-TS imports handled by Metro.
 * NativeWind injects the compiled Tailwind CSS through Metro, so the
 * side-effect `import '../global.css'` needs a module declaration.
 */
declare module '*.css';
